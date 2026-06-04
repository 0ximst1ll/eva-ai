import type { LLMClient } from '../llm/llm-client.js';
import { formatProviderError, type FormattedProviderError } from '../llm/provider-errors.js';
import type { AgentMessage, AgentSessionEvent, Message } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { Agent } from './agent.js';
import {
  buildCompactionMessages,
  extractCompactionSummary,
  prepareCompactionInput,
  type CompactionResult,
} from './compaction.js';
import { createInternalAgentMessage } from './agent-messages.js';
import type { ContextBuilder } from './context-builder.js';
import type { ContextManager } from './context-manager.js';
import type {
  AfterToolCallHook,
  AgentLoopEvent,
  BeforeToolCallHook,
  ToolExecutionHook,
  ToolExecutionMode,
} from './agent-loop.js';
import {
  SessionManager,
  type SessionBranchSummary,
  type SessionCompactionInfo,
  type SessionUsageInfo,
} from './session-manager.js';
import {
  formatToolResultMessageContent,
  type ToolResultBudgetOptions,
} from './tool-result-budget.js';

type AgentRunAttempt = {
  result: string;
  contextOverflowError?: Extract<AgentLoopEvent, { type: 'error' }>;
  contextOverflowEnd?: Extract<AgentLoopEvent, { type: 'agent_end' }>;
  retryableError?: Extract<AgentLoopEvent, { type: 'error' }>;
  retryableEnd?: Extract<AgentLoopEvent, { type: 'agent_end' }>;
  retryAfterMs?: number;
};

export interface AgentSessionAutoRetryOptions {
  enabled?: boolean;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  exponentialBase?: number;
}

const DEFAULT_AUTO_RETRY_OPTIONS = {
  enabled: true,
  maxRetries: 3,
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  exponentialBase: 2,
} satisfies Required<AgentSessionAutoRetryOptions>;
const DEFAULT_KEEP_RECENT_MESSAGES_AFTER_COMPACTION = 8;

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

function formatRetryableProviderError(message: string): FormattedProviderError | undefined {
  const formatted = formatProviderError(message);
  return formatted.retryable && formatted.category !== 'context_overflow' ? formatted : undefined;
}

function normalizeAutoRetryOptions(options?: AgentSessionAutoRetryOptions): Required<AgentSessionAutoRetryOptions> {
  return {
    enabled: options?.enabled ?? DEFAULT_AUTO_RETRY_OPTIONS.enabled,
    maxRetries: options?.maxRetries ?? DEFAULT_AUTO_RETRY_OPTIONS.maxRetries,
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_AUTO_RETRY_OPTIONS.initialDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_AUTO_RETRY_OPTIONS.maxDelayMs,
    exponentialBase: options?.exponentialBase ?? DEFAULT_AUTO_RETRY_OPTIONS.exponentialBase,
  };
}

function calculateAutoRetryDelay(options: Required<AgentSessionAutoRetryOptions>, attempt: number): number {
  const delay = options.initialDelayMs * Math.pow(options.exponentialBase, attempt - 1);
  return Math.min(delay, options.maxDelayMs);
}

function resolveAutoRetryDelay(
  options: Required<AgentSessionAutoRetryOptions>,
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, options.maxDelayMs);
  }
  return calculateAutoRetryDelay(options, attempt);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('Retry cancelled'));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Retry cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createCompactionSummaryMarker({
  result,
  customInstructions,
}: {
  result: CompactionResult;
  customInstructions?: string;
}): AgentMessage {
  return createInternalAgentMessage({
    kind: 'compaction_summary',
    content: result.summary,
    metadata: {
      summaryLength: result.summary.length,
      firstKeptMessageIndex: result.firstKeptMessageIndex,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      customInstructions: Boolean(customInstructions?.trim()),
    },
  });
}

export class AgentSession {
  private readonly agent: Agent;
  private readonly llmClient: LLMClient;
  private readonly sessionManager: SessionManager;
  private readonly contextManager?: ContextManager;
  private readonly autoRetry: Required<AgentSessionAutoRetryOptions>;
  private _systemPrompt: string;
  private readonly _maxSteps?: number | null;
  private readonly toolResultBudget?: ToolResultBudgetOptions;
  readonly sessionId: string;

  apiTotalTokens = 0;

  constructor({
    llmClient,
    systemPrompt,
    tools,
    maxSteps,
    toolResultBudget,
    toolExecution,
    toolHooks,
    contextBuilder,
    contextManager,
    autoRetry,
    beforeToolCall,
    afterToolCall,
    sessionManager,
    sessionId,
  }: {
    llmClient: LLMClient;
    systemPrompt: string;
    tools: Tool[];
    maxSteps?: number | null;
    toolResultBudget?: ToolResultBudgetOptions;
    toolExecution?: ToolExecutionMode;
    toolHooks?: ToolExecutionHook[];
    contextBuilder?: ContextBuilder;
    contextManager?: ContextManager;
    autoRetry?: AgentSessionAutoRetryOptions;
    beforeToolCall?: BeforeToolCallHook;
    afterToolCall?: AfterToolCallHook;
    sessionManager: SessionManager;
    sessionId: string;
  }) {
    this._systemPrompt = systemPrompt;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.contextManager = contextManager;
    this.autoRetry = normalizeAutoRetryOptions(autoRetry);
    this._maxSteps = maxSteps;
    this.toolResultBudget = toolResultBudget;
    this.sessionId = sessionId;
    this.agent = new Agent({
      llmClient,
      systemPrompt,
      tools,
      maxSteps,
      toolResultBudget,
      toolExecution,
      toolHooks,
      contextBuilder,
      beforeToolCall,
      afterToolCall,
      messages: this.sessionManager.getMessages(sessionId),
    });
    this.apiTotalTokens = this.sessionManager.getUsageInfo(sessionId).total.total_tokens;
  }

  get messages(): AgentMessage[] {
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

  async branchToEntry(leafEntryId: string): Promise<SessionBranchSummary> {
    const summary = await this.sessionManager.branchSession({ sessionId: this.sessionId, leafEntryId });
    this.agent.setMessages(this.sessionManager.getMessages(this.sessionId));
    return summary;
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    const messages = this.sessionManager.getMessages(this.sessionId);
    if (messages.length <= 2) {
      throw new Error('Nothing to compact (session too small)');
    }
    const prepared = prepareCompactionInput({
      messages,
      keepRecentMessages: DEFAULT_KEEP_RECENT_MESSAGES_AFTER_COMPACTION,
    });

    const response = await this.llmClient.generate(
      buildCompactionMessages({
        messages: prepared.messages,
        customInstructions,
        fileOperations: prepared.fileOperations,
      }),
      null,
    );
    const summary = extractCompactionSummary(response);
    const result = await this.sessionManager.appendCompaction({
      sessionId: this.sessionId,
      summary,
      customInstructions,
      keepRecentMessages: DEFAULT_KEEP_RECENT_MESSAGES_AFTER_COMPACTION,
    });

    this.agent.setMessages([
      ...this.sessionManager.getMessages(this.sessionId),
      createCompactionSummaryMarker({ result, customInstructions }),
    ]);
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
    let retryAttemptCount = 0;
    let attempt = await this.runAgentOnceWithContextOverflowRecovery({
      signal,
      onEvent,
      suppressAgentStart: false,
      suppressRetryableError: this.autoRetry.enabled && this.autoRetry.maxRetries > 0,
    });

    while (
      this.autoRetry.enabled
      && attempt.retryableError
      && retryAttemptCount < this.autoRetry.maxRetries
      && !signal?.aborted
    ) {
      retryAttemptCount += 1;
      const delayMs = resolveAutoRetryDelay(this.autoRetry, retryAttemptCount, attempt.retryAfterMs);
      this.resetAgentToDurableMessages();
      onEvent?.({
        type: 'auto_retry_start',
        attempt: retryAttemptCount,
        maxAttempts: this.autoRetry.maxRetries,
        delayMs,
        errorMessage: attempt.retryableError.message,
      });

      try {
        await sleep(delayMs, signal);
      } catch {
        onEvent?.({
          type: 'auto_retry_end',
          success: false,
          attempt: retryAttemptCount,
          finalError: 'Retry cancelled',
        });
        this.syncUsageFromSession();
        return 'Task cancelled by user.';
      }

      attempt = await this.runAgentOnceWithContextOverflowRecovery({
        signal,
        onEvent,
        suppressAgentStart: true,
        suppressRetryableError: retryAttemptCount < this.autoRetry.maxRetries,
      });
    }

    if (attempt.retryableError) {
      this.resetAgentToDurableMessages();
    }

    if (retryAttemptCount > 0) {
      const finalError = attempt.retryableError?.message;
      onEvent?.({
        type: 'auto_retry_end',
        success: !attempt.retryableError,
        attempt: retryAttemptCount,
        ...(finalError ? { finalError } : {}),
      });
    }

    this.syncUsageFromSession();
    return attempt.result;
  }

  private async runAgentOnceWithContextOverflowRecovery({
    signal,
    onEvent,
    suppressAgentStart,
    suppressRetryableError,
  }: {
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
    suppressAgentStart: boolean;
    suppressRetryableError: boolean;
  }): Promise<AgentRunAttempt> {
    const firstAttempt = await this.runAgentOnce({
      signal,
      onEvent,
      suppressContextOverflowError: true,
      suppressRetryableError,
      suppressAgentStart,
    });
    if (!firstAttempt.contextOverflowError) {
      this.syncUsageFromSession();
      return firstAttempt;
    }

    try {
      await this.compact();
    } catch {
      onEvent?.(firstAttempt.contextOverflowError);
      if (firstAttempt.contextOverflowEnd) onEvent?.(firstAttempt.contextOverflowEnd);
      this.syncUsageFromSession();
      return firstAttempt;
    }

    const retryAttempt = await this.runAgentOnce({
      signal,
      onEvent,
      suppressContextOverflowError: false,
      suppressRetryableError,
      suppressAgentStart: true,
    });
    this.syncUsageFromSession();
    return retryAttempt;
  }

  private async runAgentOnce({
    signal,
    onEvent,
    suppressContextOverflowError,
    suppressRetryableError,
    suppressAgentStart,
  }: {
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
    suppressContextOverflowError: boolean;
    suppressRetryableError: boolean;
    suppressAgentStart?: boolean;
  }): Promise<AgentRunAttempt> {
    let contextOverflowError: Extract<AgentLoopEvent, { type: 'error' }> | undefined;
    let contextOverflowEnd: Extract<AgentLoopEvent, { type: 'agent_end' }> | undefined;
    let retryableError: Extract<AgentLoopEvent, { type: 'error' }> | undefined;
    let retryableEnd: Extract<AgentLoopEvent, { type: 'agent_end' }> | undefined;
    let retryAfterMs: number | undefined;
    const unsubscribe = this.agent.subscribe(async (event) => {
      if (event.type === 'error') {
        const errorText = `${event.message}\n${event.error ?? ''}`;
        if (isContextOverflowErrorMessage(errorText)) {
          contextOverflowError = event;
        } else {
          const formatted = formatRetryableProviderError(errorText);
          if (formatted) {
            retryableError = event;
            retryAfterMs = formatted.retryAfterMs;
          }
        }
      }
      if (event.type === 'agent_end' && contextOverflowError) {
        contextOverflowEnd = event;
      }
      if (event.type === 'agent_end' && retryableError) {
        retryableEnd = event;
      }

      const shouldSuppress = (event.type === 'agent_start' && suppressAgentStart)
        || (suppressContextOverflowError && (event === contextOverflowError || event === contextOverflowEnd))
        || (suppressRetryableError && (event === retryableError || event === retryableEnd));
      await this.handleAgentEvent(event, shouldSuppress ? undefined : onEvent);
    });

    try {
      const result = await this.agent.continue({ signal });
      return { result, contextOverflowError, contextOverflowEnd, retryableError, retryableEnd, retryAfterMs };
    } finally {
      unsubscribe();
    }
  }

  private syncUsageFromSession(): void {
    this.apiTotalTokens = this.sessionManager.getUsageInfo(this.sessionId).total.total_tokens;
    this.agent.apiTotalTokens = this.apiTotalTokens;
  }

  private resetAgentToDurableMessages(): void {
    this.agent.setMessages(this.sessionManager.getMessages(this.sessionId));
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
      if (event.message.role !== 'internal') {
        await this.sessionManager.appendMessage(this.sessionId, event.message);
      }
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
        content: formatToolResultMessageContent(event.result),
        tool_call_id: event.result.toolCallId,
        name: event.result.toolName,
        details: event.result.details,
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

  private isLegacySessionEvent(event: AgentLoopEvent): event is AgentLoopEvent & AgentSessionEvent {
    return [
      'agent_start',
      'agent_end',
      'message_start',
      'thinking_delta',
      'content_delta',
      'tool_call',
      'tool_execution_update',
      'usage',
      'message_end',
      'error',
    ].includes(event.type);
  }

}
