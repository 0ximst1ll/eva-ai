import type { LLMClient } from '../llm/llm-client.js';
import type { AgentSessionEvent, Message } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { Agent } from './agent.js';
import type { ContextBuilder } from './context-builder.js';
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentLoopEvent,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ToolExecutionMode,
} from './agent-loop.js';
import { SessionManager } from './session-manager.js';

export class AgentSession {
  private readonly agent: Agent;
  private readonly sessionManager: SessionManager;
  readonly sessionId: string;
  readonly systemPrompt: string;

  apiTotalTokens = 0;

  constructor({
    llmClient,
    systemPrompt,
    tools,
    maxSteps = 50,
    toolExecution,
    contextBuilder,
    beforeToolCall,
    afterToolCall,
    sessionManager,
    sessionId,
  }: {
    llmClient: LLMClient;
    systemPrompt: string;
    tools: Tool[];
    maxSteps?: number;
    toolExecution?: ToolExecutionMode;
    contextBuilder?: ContextBuilder;
    beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) =>
      BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;
    afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) =>
      AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;
    sessionManager: SessionManager;
    sessionId: string;
  }) {
    this.systemPrompt = systemPrompt;
    this.sessionManager = sessionManager;
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
  }

  get messages(): Message[] {
    return this.sessionManager.getMessages(this.sessionId);
  }

  async addUserMessage(content: string): Promise<void> {
    const message = { role: 'user', content } satisfies Message;
    await this.sessionManager.appendMessage(this.sessionId, message);
    this.agent.addMessage(message);
  }

  async clear(): Promise<void> {
    await this.sessionManager.resetSession(this.sessionId, this.systemPrompt);
    this.agent.reset(this.sessionManager.getMessages(this.sessionId));
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
    const unsubscribe = this.agent.subscribe(async (event) => {
      await this.handleAgentEvent(event, onEvent);
    });

    try {
      const result = await this.agent.continue({ signal });
      this.apiTotalTokens = this.agent.apiTotalTokens;
      return result;
    } finally {
      unsubscribe();
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
