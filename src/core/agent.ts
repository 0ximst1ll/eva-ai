import type { LLMClient } from '../llm/llm-client.js';
import type { Message } from '../schema.js';
import type { Tool } from '../tools/base.js';
import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentLoopEvent,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  runAgentLoop,
  type ToolExecutionMode,
} from './agent-loop.js';

type QueueMode = 'all' | 'one-at-a-time';

type ActiveRun = {
  promise: Promise<string>;
  abortController: AbortController;
};

class PendingMessageQueue {
  private messages: Message[] = [];

  constructor(public mode: QueueMode = 'one-at-a-time') {}

  enqueue(message: Message): void {
    this.messages.push(message);
  }

  drain(): Message[] {
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
  messages: Message[];
  tools: Tool[];
  isStreaming: boolean;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
}

export interface AgentOptions {
  llmClient: LLMClient;
  systemPrompt: string;
  tools: Tool[];
  messages?: Message[];
  maxSteps?: number;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) =>
    BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) =>
    AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;
}

export class Agent {
  private readonly llmClient: LLMClient;
  private readonly listeners = new Set<(event: AgentLoopEvent, signal: AbortSignal) => void | Promise<void>>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  private activeRun?: ActiveRun;
  private _state: AgentState;
  private maxSteps: number;
  private toolExecution?: ToolExecutionMode;
  private beforeToolCall?: AgentOptions['beforeToolCall'];
  private afterToolCall?: AgentOptions['afterToolCall'];

  apiTotalTokens = 0;

  constructor(options: AgentOptions) {
    this.llmClient = options.llmClient;
    this.maxSteps = options.maxSteps ?? 50;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? 'one-at-a-time');
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? 'one-at-a-time');
    this.toolExecution = options.toolExecution;
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

  get messages(): Message[] {
    return this._state.messages;
  }

  setMessages(messages: Message[]): void {
    this._state.messages = messages.slice();
  }

  addMessage(message: Message): void {
    this._state.messages = [...this._state.messages, message];
  }

  setTools(tools: Tool[]): void {
    this._state.tools = tools.slice();
  }

  setMaxSteps(maxSteps: number): void {
    this.maxSteps = maxSteps;
  }

  subscribe(listener: (event: AgentLoopEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: Message): void {
    this.steeringQueue.enqueue(message);
  }

  followUp(message: Message): void {
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

  reset(messages?: Message[]): void {
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
      messages: this._state.messages,
      signal,
      emit: (event) => this.processEvent(event, signal),
      getSteeringMessages: () => this.steeringQueue.drain(),
      getFollowUpMessages: () => this.followUpQueue.drain(),
      toolExecution: this.toolExecution,
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
