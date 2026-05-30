import { encode } from 'gpt-tokenizer';

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalTokens?: number;
  originalChars?: number;
  truncation?: ToolOutputTruncationDetails;
}

export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 24000;

export type ToolOutputTruncationStrategy = 'head' | 'tail' | 'middle' | 'token_middle';

export interface ToolOutputTruncationDetails {
  truncated: boolean;
  strategy: ToolOutputTruncationStrategy;
  originalChars: number;
  shownChars: number;
  maxChars?: number;
  originalLines: number;
  shownLines: number;
  fullOutputPath?: string;
}

export function truncateTextByTokens(text: string, maxTokens: number): TruncationResult {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return { content: text, truncated: false, originalTokens: tokens.length };

  const ratio = tokens.length / Math.max(text.length, 1);
  const charsPerHalf = Math.floor((maxTokens / 2 / ratio) * 0.95);

  let head = text.slice(0, charsPerHalf);
  const lastNewlineHead = head.lastIndexOf('\n');
  if (lastNewlineHead > 0) head = head.slice(0, lastNewlineHead);

  let tail = text.slice(-charsPerHalf);
  const firstNewlineTail = tail.indexOf('\n');
  if (firstNewlineTail > 0) tail = tail.slice(firstNewlineTail + 1);

  const content = head + `\n\n... [Content truncated: ${tokens.length} tokens -> ~${maxTokens} tokens limit] ...\n\n` + tail;
  return {
    content,
    truncated: true,
    originalTokens: tokens.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'token_middle',
    }),
  };
}

export function truncateMiddle(text: string, maxChars: number, fullOutputPath?: string): TruncationResult {
  if (text.length <= maxChars) return { content: text || '(no output)', truncated: false, originalChars: text.length };
  const keep = Math.floor(maxChars / 2);
  const content =
    text.slice(0, keep) +
    `\n\n... [output truncated: ${text.length} chars; full output: ${fullOutputPath ?? 'unavailable'}] ...\n\n` +
    text.slice(-keep);
  return {
    content,
    truncated: true,
    originalChars: text.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'middle',
      maxChars,
      fullOutputPath,
    }),
  };
}

export function truncateHeadByChars(text: string, maxChars: number, marker: string): TruncationResult {
  if (text.length <= maxChars) return { content: text || '(no output)', truncated: false, originalChars: text.length };

  const suffix = `\n\n${marker}`;
  const headLimit = Math.max(0, maxChars - suffix.length);
  let head = text.slice(0, headLimit);
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline > 0) head = head.slice(0, lastNewline);

  const content = `${head}${suffix}`.slice(0, maxChars);
  return {
    content,
    truncated: true,
    originalChars: text.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'head',
      maxChars,
    }),
  };
}

export function truncateTailByChars(text: string, maxChars: number, marker: string): TruncationResult {
  if (text.length <= maxChars) return { content: text || '(no output)', truncated: false, originalChars: text.length };

  const prefix = `${marker}\n\n`;
  const tailLimit = Math.max(0, maxChars - prefix.length);
  let tail = text.slice(-tailLimit);
  const firstNewline = tail.indexOf('\n');
  if (firstNewline > 0) tail = tail.slice(firstNewline + 1);

  const content = `${prefix}${tail}`.slice(0, maxChars);
  return {
    content,
    truncated: true,
    originalChars: text.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'tail',
      maxChars,
    }),
  };
}

export function createToolOutputTruncation({
  original,
  shown,
  strategy,
  maxChars,
  fullOutputPath,
}: {
  original: string;
  shown: string;
  strategy: ToolOutputTruncationStrategy;
  maxChars?: number;
  fullOutputPath?: string;
}): ToolOutputTruncationDetails {
  return {
    truncated: original !== shown,
    strategy,
    originalChars: original.length,
    shownChars: shown.length,
    maxChars,
    originalLines: countLines(original),
    shownLines: countLines(shown),
    fullOutputPath,
  };
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}
