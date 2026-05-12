import type { LLMClient } from '../llm/llm-client.js';
import type { AgentSessionEvent, Message } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { Agent } from './agent.js';
import {
  buildCompactionMessages,
  extractCompactionSummary,
  type CompactionResult,
} from './compaction.js';
import type { ContextBuilder } from './context-builder.js';
import type { ContextManager } from './context-manager.js';
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentLoopEvent,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ToolExecutionMode,
} from './agent-loop.js';
import { SessionManager, type SessionCompactionInfo, type SessionUsageInfo } from './session-manager.js';

type AgentRunAttempt = {
  result: string;
  contextOverflowError?: Extract<AgentLoopEvent, { type: 'error' }>;
};

function isContextOverflowErrorMessage(message: string): boolean {
  return [
    /context_length_exceeded/i,
    /context window/i,
    /context length/i,
    /maximum context/i,
    /prompt(?:\s+\S+){0,4}\s+too long/i,
    /input(?:\s+\S+){0,8}\s+(?:too long|exceed)/i,
    /token(?:\s+\S+){0,8}\s+exceed/i,
    /exceed(?:s|ed|ing)?(?:\s+\S+){0,8}\s+(?:context|tokens?|maximum input)/i,
    /too many tokens/i,
    /request too large/i,
  ].some((pattern) => pattern.test(message));
}

export class AgentSession {
  private readonly agent: Agent;
  private readonly llmClient: LLMClient;
  private readonly sessionManager: SessionManager;
  private readonly contextManager?: ContextManager;
  private _systemPrompt: string;
  private readonly _maxSteps?: number | null;
  readonly sessionId: string;

  apiTotalTokens = 0;

  constructor({
    llmClient,
    systemPrompt,
    tools,
    maxSteps,
    toolExecution,
    contextBuilder,
    contextManager,
    beforeToolCall,
    afterToolCall,
    sessionManager,
    sessionId,
  }: {
    llmClient: LLMClient;
    systemPrompt: string;
    tools: Tool[];
    maxSteps?: number | null;
    toolExecution?: ToolExecutionMode;
    contextBuilder?: ContextBuilder;
    contextManager?: ContextManager;
    beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) =>
      BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;
    afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) =>
      AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;
    sessionManager: SessionManager;
    sessionId: string;
  }) {
    this._systemPrompt = systemPrompt;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.contextManager = contextManager;
    this._maxSteps = maxSteps;
    this.sessionId = sessionId;
    this.agent = new Agent({
      llmClient,
      systemPrompt,
      tools,
      maxSteps,
      toolExecution,
      contextBuilder,
      beforeToolCall,
      afterToolCall,
      messages: this.sessionManager.getMessages(sessionId),
    });
    this.apiTotalTokens = this.sessionManager.getUsageInfo(sessionId).total.total_tokens;
  }

  get messages(): Message[] {
    return this.sessionManager.getMessages(this.sessionId);
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get maxSteps(): number | null | undefined {
    return this._maxSteps;
  }

  get compaction(): SessionCompactionInfo {
    return this.sessionManager.getCompactionInfo(this.sessionId);
  }

  get usage(): SessionUsageInfo {
    return this.sessionManager.getUsageInfo(this.sessionId);
  }

  updateRuntimeResources({
    systemPrompt,
    contextBuilder,
  }: {
    systemPrompt: string;
    contextBuilder?: ContextBuilder;
  }): void {
    this._systemPrompt = systemPrompt;
    this.agent.setSystemPrompt(systemPrompt);
    this.agent.setContextBuilder(contextBuilder);
  }

  async addUserMessage(content: string): Promise<void> {
    const message = { role: 'user', content } satisfies Message;
    await this.sessionManager.appendMessage(this.sessionId, message);
    this.agent.addMessage(message);
  }

  async clear(): Promise<void> {
    await this.sessionManager.resetSession(this.sessionId, this._systemPrompt);
    this.agent.reset(this.sessionManager.getMessages(this.sessionId));
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    const messages = this.sessionManager.getMessages(this.sessionId);
    if (messages.length <= 2) {
      throw new Error('Nothing to compact (session too small)');
    }

    const response = await this.llmClient.generate(
      buildCompactionMessages({ messages, customInstructions }),
      null,
    );
    const summary = extractCompactionSummary(response);
    const result = await this.sessionManager.appendCompaction({
      sessionId: this.sessionId,
      summary,
      customInstructions,
    });

    this.agent.setMessages(this.sessionManager.getMessages(this.sessionId));
    if (response.usage) {
      await this.sessionManager.appendUsage({
        sessionId: this.sessionId,
        usage: response.usage,
        source: 'compaction',
      });
      this.apiTotalTokens = this.sessionManager.getUsageInfo(this.sessionId).total.total_tokens;
      this.agent.apiTotalTokens = this.apiTotalTokens;
    }
    return result;
  }

  steer(content: string): void {
    this.agent.steer({ role: 'user', content });
  }

  followUp(content: string): void {
    this.agent.followUp({ role: 'user', content });
  }

  async run({
    signal,
    onEvent,
  }: {
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  } = {}): Promise<string> {
    await this.compactIfRecommended();
    const firstAttempt = await this.runAgentOnce({ signal, onEvent, suppressContextOverflowError: true });
    if (!firstAttempt.contextOverflowError) {
      this.syncUsageFromSession();
      return firstAttempt.result;
    }

    try {
      await this.compact();
    } catch {
      onEvent?.(firstAttempt.contextOverflowError);
      this.syncUsageFromSession();
      return firstAttempt.result;
    }

    const retryAttempt = await this.runAgentOnce({ signal, onEvent, suppressContextOverflowError: false });
    this.syncUsageFromSession();
    return retryAttempt.result;
  }

  private async runAgentOnce({
    signal,
    onEvent,
    suppressContextOverflowError,
  }: {
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
    suppressContextOverflowError: boolean;
  }): Promise<AgentRunAttempt> {
    let contextOverflowError: Extract<AgentLoopEvent, { type: 'error' }> | undefined;
    const unsubscribe = this.agent.subscribe(async (event) => {
      if (event.type === 'error' && isContextOverflowErrorMessage(event.message)) {
        contextOverflowError = event;
      }
      await this.handleAgentEvent(
        event,
        suppressContextOverflowError && event === contextOverflowError ? undefined : onEvent,
      );
    });

    try {
      const result = await this.agent.continue({ signal });
      return { result, contextOverflowError };
    } finally {
      unsubscribe();
    }
  }

  private syncUsageFromSession(): void {
    this.apiTotalTokens = this.sessionManager.getUsageInfo(this.sessionId).total.total_tokens;
    this.agent.apiTotalTokens = this.apiTotalTokens;
  }

  private async compactIfRecommended(): Promise<void> {
    if (!this.contextManager) return;

    const diagnostics = await this.contextManager.getDiagnostics({
      sessionId: this.sessionId,
      messages: this.sessionManager.getMessages(this.sessionId),
      maxSteps: this._maxSteps,
      usageSource: 'active_messages',
    });
    if (diagnostics.compactionRecommendation.reason !== 'reserve_reached') return;

    try {
      await this.compact();
    } catch {
      // Auto compaction must never make a runnable session unusable.
    }
  }

  private async handleAgentEvent(
    event: AgentLoopEvent,
    onEvent?: (event: AgentSessionEvent) => void,
  ): Promise<void> {
    if (event.type === 'input_message') {
      await this.sessionManager.appendMessage(this.sessionId, event.message);
      return;
    }

    if (event.type === 'assistant_message') {
      await this.sessionManager.appendMessage(this.sessionId, event.message);
      return;
    }

    if (event.type === 'tool_result') {
      onEvent?.(event);
      await this.sessionManager.appendMessage(this.sessionId, {
        role: 'tool',
        content: event.result.success ? event.result.content : `Error: ${event.result.error ?? 'Unknown error'}`,
        tool_call_id: event.result.toolCallId,
        name: event.result.toolName,
      });
      return;
    }

    if (event.type === 'message_end') {
      if (event.response.usage) {
        await this.sessionManager.appendUsage({
          sessionId: this.sessionId,
          usage: event.response.usage,
          source: 'assistant',
        });
      }
      onEvent?.(event);
      return;
    }

    if (this.isLegacySessionEvent(event)) {
      onEvent?.(event);
    }
  }

  private isLegacySessionEvent(event: AgentLoopEvent): event is AgentSessionEvent {
    return [
      'message_start',
      'thinking_delta',
      'content_delta',
      'tool_call',
      'usage',
      'message_end',
      'error',
    ].includes(event.type);
  }
}
