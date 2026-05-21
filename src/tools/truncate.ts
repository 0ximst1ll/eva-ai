import { encode } from 'gpt-tokenizer';

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalTokens?: number;
  originalChars?: number;
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

  return {
    content: head + `\n\n... [Content truncated: ${tokens.length} tokens -> ~${maxTokens} tokens limit] ...\n\n` + tail,
    truncated: true,
    originalTokens: tokens.length,
  };
}

export function truncateMiddle(text: string, maxChars: number, fullOutputPath?: string): TruncationResult {
  if (text.length <= maxChars) return { content: text || '(no output)', truncated: false, originalChars: text.length };
  const keep = Math.floor(maxChars / 2);
  return {
    content:
      text.slice(0, keep) +
      `\n\n... [output truncated: ${text.length} chars; full output: ${fullOutputPath ?? 'unavailable'}] ...\n\n` +
      text.slice(-keep),
    truncated: true,
    originalChars: text.length,
  };
}
