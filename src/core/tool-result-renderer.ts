import type { Message, ToolExecutionResult } from '../schema.js';
import { renderToolResult, type Tool, type ToolRenderResultOptions } from '../tools/base.js';
import { flattenToolResultContent } from './tool-result-budget.js';

export interface RenderToolExecutionResultInput {
  tool?: Tool;
  result: ToolExecutionResult;
  args?: Record<string, unknown>;
  options?: ToolRenderResultOptions;
}

export interface RenderToolMessageResultInput {
  tool?: Tool;
  message: Extract<Message, { role: 'tool' }>;
  args?: Record<string, unknown>;
  options?: ToolRenderResultOptions;
}

export function renderToolExecutionResult({
  tool,
  result,
  args = result.args ?? {},
  options = {},
}: RenderToolExecutionResultInput): string {
  const normalized = normalizeToolExecutionResultForRendering(result);
  const rendered = tool
    ? renderToolResult(
        tool,
        normalized,
        {
          toolCallId: normalized.toolCallId,
          args,
        },
        options,
      )
    : undefined;
  return rendered ?? normalized.displayContent ?? fallbackToolResultText(normalized);
}

export function renderToolMessageResult({
  tool,
  message,
  args = {},
  options = {},
}: RenderToolMessageResultInput): string {
  return renderToolExecutionResult({
    tool,
    args,
    options,
    result: toolExecutionResultFromMessage(message),
  });
}

export function renderToolMessageForExportText(input: RenderToolMessageResultInput): string {
  return renderToolMessageResult({
    ...input,
    options: {
      ...input.options,
      expanded: input.options?.expanded ?? true,
    },
  });
}

export function toolExecutionResultFromMessage(message: Extract<Message, { role: 'tool' }>): ToolExecutionResult {
  const errorPrefix = 'Error: ';
  const isError = message.content.startsWith(errorPrefix);
  return {
    toolCallId: message.tool_call_id,
    toolName: message.name ?? 'tool',
    success: !isError,
    content: message.content,
    contentBlocks: message.contentBlocks,
    error: isError ? message.content.slice(errorPrefix.length) : undefined,
    details: message.details,
  };
}

function normalizeToolExecutionResultForRendering(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.success || !result.contentBlocks?.length) return result;
  return {
    ...result,
    content: flattenToolResultContent(result),
  };
}

function fallbackToolResultText(result: ToolExecutionResult): string {
  if (!result.success) return result.error ?? result.content;
  return flattenToolResultContent(result);
}
