import { encode } from 'gpt-tokenizer';

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalTokens?: number;
  originalChars?: number;
  truncation?: ToolOutputTruncationDetails;
}

export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 24000;
export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;

export type ToolOutputTruncationStrategy = 'head' | 'tail' | 'middle' | 'token_middle';
export type ToolOutputTruncatedBy = 'lines' | 'bytes' | null;

export interface ToolOutputTruncationDetails {
  truncated: boolean;
  strategy: ToolOutputTruncationStrategy;
  truncatedBy: ToolOutputTruncatedBy;
  originalChars: number;
  shownChars: number;
  maxChars?: number;
  originalLines: number;
  shownLines: number;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxLines?: number;
  maxBytes?: number;
  lastLinePartial?: boolean;
  firstLineExceedsLimit?: boolean;
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
      maxBytes: maxChars,
      fullOutputPath,
    }),
  };
}

export function truncateHeadByChars(text: string, maxChars: number, marker: string): TruncationResult {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  const totalLines = countLines(text);
  if (text.length <= maxChars && totalBytes <= maxChars && totalLines <= DEFAULT_TOOL_OUTPUT_MAX_LINES) {
    return { content: text || '(no output)', truncated: false, originalChars: text.length };
  }

  const suffix = `\n\n${marker}`;
  const head = truncateHeadByLinesAndBytes(text, {
    maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
    maxBytes: Math.max(0, maxChars - Buffer.byteLength(suffix, 'utf-8')),
  });
  const content = `${head.content}${suffix}`;
  return {
    content,
    truncated: true,
    originalChars: text.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'head',
      maxChars,
      maxBytes: maxChars,
      maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
      outputLines: head.outputLines,
      outputBytes: head.outputBytes,
      truncatedBy: head.truncatedBy,
      firstLineExceedsLimit: head.firstLineExceedsLimit,
    }),
  };
}

export function truncateTailByChars(text: string, maxChars: number, marker: string): TruncationResult {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  const totalLines = countLines(text);
  if (text.length <= maxChars && totalBytes <= maxChars && totalLines <= DEFAULT_TOOL_OUTPUT_MAX_LINES) {
    return { content: text || '(no output)', truncated: false, originalChars: text.length };
  }

  const prefix = `${marker}\n\n`;
  const tail = truncateTailByLinesAndBytes(text, {
    maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
    maxBytes: Math.max(0, maxChars - Buffer.byteLength(prefix, 'utf-8')),
  });
  const content = `${prefix}${tail.content}`;
  return {
    content,
    truncated: true,
    originalChars: text.length,
    truncation: createToolOutputTruncation({
      original: text,
      shown: content,
      strategy: 'tail',
      maxChars,
      maxBytes: maxChars,
      maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
      outputLines: tail.outputLines,
      outputBytes: tail.outputBytes,
      truncatedBy: tail.truncatedBy,
      lastLinePartial: tail.lastLinePartial,
    }),
  };
}

export interface LineByteTruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface LineByteTruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: ToolOutputTruncatedBy;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
}

export function truncateHeadByLinesAndBytes(
  content: string,
  options: LineByteTruncationOptions = {},
): LineByteTruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, 'utf-8');

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return createLineByteResult({
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      maxLines,
      maxBytes,
    });
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? '', 'utf-8');
  if (firstLineBytes > maxBytes) {
    return createLineByteResult({
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      maxLines,
      maxBytes,
      firstLineExceedsLimit: true,
    });
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: Exclude<ToolOutputTruncatedBy, null> = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (outputLines.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLines.push(lines[i]);
    outputBytes += lineBytes;
  }

  return createLineByteResult({
    content: outputLines.join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    maxLines,
    maxBytes,
  });
}

export function truncateTailByLinesAndBytes(
  content: string,
  options: LineByteTruncationOptions = {},
): LineByteTruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, 'utf-8');

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return createLineByteResult({
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      maxLines,
      maxBytes,
    });
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: Exclude<ToolOutputTruncatedBy, null> = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (outputLines.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (!outputLines.length) {
        const line = truncateStringToBytesFromEnd(lines[i], maxBytes);
        outputLines.unshift(line);
        outputBytes = Buffer.byteLength(line, 'utf-8');
        lastLinePartial = true;
      }
      break;
    }
    outputLines.unshift(lines[i]);
    outputBytes += lineBytes;
  }

  return createLineByteResult({
    content: outputLines.join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    maxLines,
    maxBytes,
    lastLinePartial,
  });
}

function createLineByteResult({
  content,
  truncated,
  truncatedBy,
  totalLines,
  totalBytes,
  outputLines,
  maxLines,
  maxBytes,
  lastLinePartial = false,
  firstLineExceedsLimit = false,
}: {
  content: string;
  truncated: boolean;
  truncatedBy: ToolOutputTruncatedBy;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  maxLines: number;
  maxBytes: number;
  lastLinePartial?: boolean;
  firstLineExceedsLimit?: boolean;
}): LineByteTruncationResult {
  return {
    content,
    truncated,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes: Buffer.byteLength(content, 'utf-8'),
    maxLines,
    maxBytes,
    lastLinePartial,
    firstLineExceedsLimit,
  };
}

function splitLinesForCounting(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function truncateStringToBytesFromEnd(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf-8');
  if (buffer.length <= maxBytes) return value;

  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start++;
  }
  return buffer.slice(start).toString('utf-8');
}

export function createToolOutputTruncation({
  original,
  shown,
  strategy,
  maxChars,
  maxLines,
  maxBytes,
  outputLines,
  outputBytes,
  truncatedBy,
  lastLinePartial,
  firstLineExceedsLimit,
  fullOutputPath,
}: {
  original: string;
  shown: string;
  strategy: ToolOutputTruncationStrategy;
  maxChars?: number;
  maxLines?: number;
  maxBytes?: number;
  outputLines?: number;
  outputBytes?: number;
  truncatedBy?: ToolOutputTruncatedBy;
  lastLinePartial?: boolean;
  firstLineExceedsLimit?: boolean;
  fullOutputPath?: string;
}): ToolOutputTruncationDetails {
  const originalLines = countLines(original);
  const shownLines = countLines(shown);
  const originalBytes = Buffer.byteLength(original, 'utf-8');
  const shownBytes = Buffer.byteLength(shown, 'utf-8');
  const isTruncated = original !== shown;
  return {
    truncated: isTruncated,
    strategy,
    truncatedBy: truncatedBy ?? inferTruncatedBy({
      truncated: isTruncated,
      originalLines,
      shownLines,
      originalBytes,
      shownBytes,
      maxBytes,
    }),
    originalChars: original.length,
    shownChars: shown.length,
    maxChars,
    originalLines,
    shownLines,
    totalLines: originalLines,
    outputLines: outputLines ?? shownLines,
    totalBytes: originalBytes,
    outputBytes: outputBytes ?? shownBytes,
    maxLines,
    maxBytes,
    lastLinePartial,
    firstLineExceedsLimit,
    fullOutputPath,
  };
}

export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.length;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatToolOutputTruncationSummary(truncation: ToolOutputTruncationDetails): string {
  if (!truncation.truncated) return '';
  const by = truncation.truncatedBy ? ` by ${truncation.truncatedBy}` : '';
  return `truncated${by} ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}`;
}

function inferTruncatedBy({
  truncated,
  originalLines,
  shownLines,
  originalBytes,
  shownBytes,
  maxBytes,
}: {
  truncated: boolean;
  originalLines: number;
  shownLines: number;
  originalBytes: number;
  shownBytes: number;
  maxBytes?: number;
}): ToolOutputTruncatedBy {
  if (!truncated) return null;
  if (maxBytes !== undefined && (originalBytes > maxBytes || shownBytes < originalBytes)) return 'bytes';
  if (shownLines < originalLines) return 'lines';
  if (shownBytes < originalBytes) return 'bytes';
  return null;
}
