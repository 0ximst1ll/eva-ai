import type { ToolExecutionResult } from '../schema.js';

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
  const content = truncateText(result.content, maxChars, 'Tool result', result.contentArtifact?.artifactId);
  if (content.truncated) {
    next = {
      ...next,
      content: content.text,
      contentTruncated: true,
      originalContentLength: content.originalLength,
      maxContentLength: maxChars,
    };
  }

  if (result.error !== undefined) {
    const error = truncateText(result.error, maxChars, 'Tool error', result.errorArtifact?.artifactId);
    if (error.truncated) {
      next = {
        ...next,
        error: error.text,
        errorTruncated: true,
        originalErrorLength: error.originalLength,
        maxErrorLength: maxChars,
      };
    }
  }

  return next;
}

export function formatToolResultMessageContent(result: ToolExecutionResult): string {
  return result.success ? result.content : `Error: ${result.error ?? 'Unknown error'}`;
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
  artifactId?: string,
): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalLength: text.length };
  }

  const artifactSuffix = artifactId ? ` artifact=${artifactId}` : '';
  const marker = `\n\n[${label} truncated: original=${text.length} budget=${maxChars}${artifactSuffix}]`;
  const previewLength = Math.max(0, maxChars - marker.length);
  const truncatedText = `${text.slice(0, previewLength)}${marker}`.slice(0, maxChars);
  return {
    text: truncatedText,
    truncated: true,
    originalLength: text.length,
  };
}
