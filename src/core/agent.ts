import type { LLMClient } from '../llm/llm-client.js';
import type { AgentMessage } from '../schema.js';
import type { Tool } from '../tools/base.js';
import type { ConvertToLlm, TransformContext } from './agent-messages.js';
import type { ContextBuilder } from './context-builder.js';
import {
  type AfterToolCallHook,
  type AgentLoopEvent,
  type BeforeToolCallHook,
  type ToolExecutionHook,
  runAgentLoop,
  type ToolExecutionMode,
} from './agent-loop.js';
import type { ToolResultBudgetOptions } from './tool-result-budget.js';

type QueueMode = 'all' | 'one-at-a-time';

type ActiveRun = {
  promise: Promise<string>;
  abortController: AbortController;
};

class PendingMessageQueue {
  private messages: AgentMessage[] = [];

  constructor(public mode: QueueMode = 'one-at-a-time') {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  drain(): AgentMessage[] {
    if (this.mode === 'all') {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }

    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }

  get size(): number {
    return this.messages.length;
  }
}

export interface AgentState {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
  isStreaming: boolean;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
}

export interface AgentOptions {
  llmClient: LLMClient;
  systemPrompt: string;
  tools: Tool[];
  messages?: AgentMessage[];
  contextBuilder?: ContextBuilder;
  transformContext?: TransformContext;
  convertToLlm?: ConvertToLlm;
  maxSteps?: number | null;
  toolResultBudget?: ToolResultBudgetOptions;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  toolHooks?: ToolExecutionHook[];
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
}

export class Agent {
  private readonly llmClient: LLMClient;
  private readonly listeners = new Set<(event: AgentLoopEvent, signal: AbortSignal) => void | Promise<void>>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  private activeRun?: ActiveRun;
  private _state: AgentState;
  private maxSteps?: number | null;
  private toolResultBudget?: ToolResultBudgetOptions;
  private toolExecution?: ToolExecutionMode;
  private contextBuilder?: ContextBuilder;
  private transformContext?: TransformContext;
  private convertToLlm?: ConvertToLlm;
  private toolHooks?: ToolExecutionHook[];
  private beforeToolCall?: AgentOptions['beforeToolCall'];
  private afterToolCall?: AgentOptions['afterToolCall'];

  apiTotalTokens = 0;

  constructor(options: AgentOptions) {
    this.llmClient = options.llmClient;
    this.maxSteps = options.maxSteps;
    this.toolResultBudget = options.toolResultBudget;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? 'one-at-a-time');
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? 'one-at-a-time');
    this.toolExecution = options.toolExecution;
    this.contextBuilder = options.contextBuilder;
    this.transformContext = options.transformContext;
    this.convertToLlm = options.convertToLlm;
    this.toolHooks = options.toolHooks?.slice();
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this._state = {
      systemPrompt: options.systemPrompt,
      messages: options.messages?.slice() ?? [{ role: 'system', content: options.systemPrompt }],
      tools: options.tools.slice(),
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    };
  }

  get state(): AgentState {
    return this._state;
  }

  get messages(): AgentMessage[] {
    return this._state.messages;
  }

  setMessages(messages: AgentMessage[]): void {
    this._state.messages = messages.slice();
  }

  addMessage(message: AgentMessage): void {
    this._state.messages = [...this._state.messages, message];
  }

  setTools(tools: Tool[]): void {
    this._state.tools = tools.slice();
  }

  setSystemPrompt(systemPrompt: string): void {
    this._state.systemPrompt = systemPrompt;
  }

  setContextBuilder(contextBuilder: ContextBuilder | undefined): void {
    this.contextBuilder = contextBuilder;
  }

  setTransformContext(transformContext: TransformContext | undefined): void {
    this.transformContext = transformContext;
  }

  setConvertToLlm(convertToLlm: ConvertToLlm | undefined): void {
    this.convertToLlm = convertToLlm;
  }

  setMaxSteps(maxSteps?: number | null): void {
    this.maxSteps = maxSteps;
  }

  setToolResultBudget(toolResultBudget: ToolResultBudgetOptions | undefined): void {
    this.toolResultBudget = toolResultBudget;
  }

  subscribe(listener: (event: AgentLoopEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  setToolExecution(mode: ToolExecutionMode | undefined): void {
    this.toolExecution = mode;
  }

  clearQueues(): void {
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  waitForIdle(): Promise<string | void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  async prompt(content: string): Promise<string> {
    this.addMessage({ role: 'user', content });
    return this.continue();
  }

  async continue(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.activeRun) {
      throw new Error('Agent is already processing. Use steer() or followUp() to queue messages.');
    }

    const abortController = new AbortController();
    const externalAbort = () => abortController.abort();
    if (options.signal?.aborted) abortController.abort();
    else options.signal?.addEventListener('abort', externalAbort, { once: true });

    const run = this.runWithLifecycle(abortController.signal)
      .finally(() => {
        options.signal?.removeEventListener('abort', externalAbort);
        this.activeRun = undefined;
      });
    this.activeRun = { promise: run, abortController };
    return run;
  }

  reset(messages?: AgentMessage[]): void {
    this._state.messages = messages?.slice() ?? [{ role: 'system', content: this._state.systemPrompt }];
    this._state.isStreaming = false;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.clearQueues();
  }

  private async runWithLifecycle(signal: AbortSignal): Promise<string> {
    this._state.isStreaming = true;
    this._state.errorMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();

    try {
      return await this.runOnce(signal);
    } finally {
      this._state.isStreaming = false;
      this._state.pendingToolCalls = new Set<string>();
    }
  }

  private async runOnce(signal: AbortSignal): Promise<string> {
    const result = await runAgentLoop({
      llmClient: this.llmClient,
      tools: this._state.tools,
      maxSteps: this.maxSteps,
      toolResultBudget: this.toolResultBudget,
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages,
      contextBuilder: this.contextBuilder,
      transformContext: this.transformContext,
      convertToLlm: this.convertToLlm,
      signal,
      emit: (event) => this.processEvent(event, signal),
      getSteeringMessages: () => this.steeringQueue.drain(),
      getFollowUpMessages: () => this.followUpQueue.drain(),
      toolExecution: this.toolExecution,
      toolHooks: this.toolHooks,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
    });
    this._state.messages = result.messages;
    this.apiTotalTokens = result.apiTotalTokens;
    return result.finalContent;
  }

  private async processEvent(event: AgentLoopEvent, signal: AbortSignal): Promise<void> {
    if (event.type === 'tool_execution_start') {
      const pending = new Set(this._state.pendingToolCalls);
      pending.add(event.toolCallId);
      this._state.pendingToolCalls = pending;
    } else if (event.type === 'tool_execution_end') {
      const pending = new Set(this._state.pendingToolCalls);
      pending.delete(event.result.toolCallId);
      this._state.pendingToolCalls = pending;
    } else if (event.type === 'error') {
      this._state.errorMessage = event.message;
    }

    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
