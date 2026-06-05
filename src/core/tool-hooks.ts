import type { AgentMessage, ToolCall, ToolExecutionResult } from '../schema.js';
import type { Tool, ToolExecutionContext } from '../tools/base.js';

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  tool?: Tool;
  args: Record<string, unknown>;
  messages: AgentMessage[];
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  toolExecutionContext?: Partial<ToolExecutionContext>;
}

export interface AfterToolCallContext {
  toolCall: ToolCall;
  tool: Tool;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  messages: AgentMessage[];
}

export interface ToolLifecycleBaseContext {
  toolCall: ToolCall;
  tool?: Tool;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  messages: AgentMessage[];
  metadata?: Tool['metadata'];
}

export interface ToolExecutionStartContext extends ToolLifecycleBaseContext {}

export interface ToolExecutionUpdateContext extends ToolLifecycleBaseContext {
  result: ToolExecutionResult;
}

export interface ToolExecutionEndContext extends ToolLifecycleBaseContext {
  result: ToolExecutionResult;
}

export type AfterToolCallResult = Partial<Pick<
  ToolExecutionResult,
  'success' | 'content' | 'contentBlocks' | 'error' | 'details' | 'displayContent'
>>;

export type BeforeToolCallHook = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;

export type AfterToolCallHook = (
  context: AfterToolCallContext,
  signal?: AbortSignal,
) => AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;

export type ToolExecutionStartHook = (
  context: ToolExecutionStartContext,
  signal?: AbortSignal,
) => void | Promise<void>;

export type ToolExecutionUpdateHook = (
  context: ToolExecutionUpdateContext,
  signal?: AbortSignal,
) => void | Promise<void>;

export type ToolExecutionEndHook = (
  context: ToolExecutionEndContext,
  signal?: AbortSignal,
) => void | Promise<void>;

export interface ToolExecutionHook {
  name?: string;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  onToolStart?: ToolExecutionStartHook;
  onToolUpdate?: ToolExecutionUpdateHook;
  onToolEnd?: ToolExecutionEndHook;
}

export async function runToolExecutionStartHooks(
  hooks: ToolExecutionHook[],
  context: ToolExecutionStartContext,
  signal?: AbortSignal,
): Promise<void> {
  await runObserverHooks(hooks, (hook) => hook.onToolStart?.({ ...context }, signal), signal);
}

export async function runToolExecutionUpdateHooks(
  hooks: ToolExecutionHook[],
  context: ToolExecutionUpdateContext,
  signal?: AbortSignal,
): Promise<void> {
  await runObserverHooks(hooks, (hook) => hook.onToolUpdate?.({ ...context, result: { ...context.result } }, signal), signal);
}

export async function runToolExecutionEndHooks(
  hooks: ToolExecutionHook[],
  context: ToolExecutionEndContext,
  signal?: AbortSignal,
): Promise<void> {
  await runObserverHooks(hooks, (hook) => hook.onToolEnd?.({ ...context, result: { ...context.result } }, signal), signal);
}

async function runObserverHooks(
  hooks: ToolExecutionHook[],
  callback: (hook: ToolExecutionHook) => void | Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  for (const hook of hooks) {
    if (signal?.aborted) break;
    try {
      await callback(hook);
    } catch {
      // Observer hooks must not affect tool execution.
    }
  }
}

export async function runBeforeToolCallHooks(
  hooks: ToolExecutionHook[],
  context: BeforeToolCallContext,
  signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
  let merged: BeforeToolCallResult | undefined;

  for (const hook of hooks) {
    if (signal?.aborted) break;
    const result = await hook.beforeToolCall?.(context, signal);
    if (!result) continue;

    merged = {
      ...merged,
      ...result,
      toolExecutionContext: {
        ...merged?.toolExecutionContext,
        ...result.toolExecutionContext,
      },
    };

    if (result.block) break;
  }

  return merged;
}

export async function runAfterToolCallHooks(
  hooks: ToolExecutionHook[],
  context: AfterToolCallContext,
  signal?: AbortSignal,
): Promise<AfterToolCallResult | undefined> {
  let merged: AfterToolCallResult | undefined;
  let currentResult = context.result;

  for (const hook of hooks) {
    if (signal?.aborted) break;
    const result = await hook.afterToolCall?.({ ...context, result: currentResult }, signal);
    if (!result) continue;

    merged = { ...merged, ...result };
    currentResult = { ...currentResult, ...result };
  }

  return merged;
}
