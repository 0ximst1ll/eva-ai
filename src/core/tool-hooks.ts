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

export interface ToolExecutionHook {
  name?: string;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
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
