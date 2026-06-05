import type { ToolExecutionResult, ToolResultContentBlock } from '../schema.js';

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20000;

export interface ToolResultBudgetOptions {
  maxChars?: number | null;
}

export function applyToolResultBudget(
  result: ToolExecutionResult,
  options: ToolResultBudgetOptions = {},
): ToolExecutionResult {
  const maxChars = normalizeMaxChars(options.maxChars);
  if (maxChars === null) return result;

  let next = result;
  const content = truncateText(flattenToolResultContent(result), maxChars, 'Tool result');
  if (content.truncated) {
    next = {
      ...next,
      content: content.text,
      contentBlocks: next.contentBlocks ? [{ type: 'text', text: content.text }] : next.contentBlocks,
      details: {
        ...next.details,
        toolResultBudget: {
          ...(isRecord(next.details?.['toolResultBudget']) ? next.details['toolResultBudget'] : {}),
          contentTruncated: true,
          originalContentLength: content.originalLength,
          maxContentLength: maxChars,
        },
      },
      contentTruncated: true,
      originalContentLength: content.originalLength,
      maxContentLength: maxChars,
    };
  }

  if (result.error !== undefined) {
    const error = truncateText(result.error, maxChars, 'Tool error');
    if (error.truncated) {
      next = {
        ...next,
        error: error.text,
        details: {
          ...next.details,
          toolResultBudget: {
            ...(isRecord(next.details?.['toolResultBudget']) ? next.details['toolResultBudget'] : {}),
            errorTruncated: true,
            originalErrorLength: error.originalLength,
            maxErrorLength: maxChars,
          },
        },
        errorTruncated: true,
        originalErrorLength: error.originalLength,
        maxErrorLength: maxChars,
      };
    }
  }

  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatToolResultMessageContent(result: ToolExecutionResult): string {
  if (!result.success) return `Error: ${result.error ?? 'Unknown error'}`;
  return flattenToolResultContent(result);
}

export function flattenToolResultContent(result: Pick<ToolExecutionResult, 'content' | 'contentBlocks'>): string {
  const blocks = result.contentBlocks;
  if (!blocks?.length) return result.content;
  const text = blocks
    .map(formatToolResultContentBlock)
    .filter((part) => part.length > 0)
    .join('\n');
  return text || result.content;
}

function formatToolResultContentBlock(block: ToolResultContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'image') return `[image:${block.mimeType}:${block.data.length}]`;
  return '';
}

function normalizeMaxChars(maxChars: number | null | undefined): number | null {
  if (maxChars === null) return null;
  if (maxChars === undefined) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  return Math.floor(maxChars);
}

export function resolveToolResultMaxChars(options: ToolResultBudgetOptions = {}): number | null {
  return normalizeMaxChars(options.maxChars);
}

function truncateText(
  text: string,
  maxChars: number,
  label: string,
): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalLength: text.length };
  }

  const marker = `\n\n[${label} truncated: original=${text.length} budget=${maxChars}]`;
  const previewLength = Math.max(0, maxChars - marker.length);
  const truncatedText = `${text.slice(0, previewLength)}${marker}`.slice(0, maxChars);
  return {
    text: truncatedText,
    truncated: true,
    originalLength: text.length,
  };
}
