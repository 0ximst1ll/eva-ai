import { createAbortedToolResult, formatToolResultDisplay, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult, type ToolResultDetails } from './base.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';
import { createToolOutputTruncation, DEFAULT_TOOL_OUTPUT_MAX_CHARS, type ToolOutputTruncationDetails } from './truncate.js';

const READ_OUTPUT_MAX_CHARS = DEFAULT_TOOL_OUTPUT_MAX_CHARS;

export interface ReadToolInput extends Record<string, unknown> {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolDetails extends ToolResultDetails {
  totalLines: number;
  startLine: number;
  endLine: number;
  shownLines: number;
  userLimited: boolean;
  nextOffset: number | null;
  truncation?: ToolOutputTruncationDetails;
}

function renderReadCall({ path, offset, limit }: ReadToolInput): string {
  if (offset === undefined && limit === undefined) return `read ${path || '...'}`;
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return `read ${path || '...'}:${start}${end !== undefined ? `-${end}` : ''}`;
}

export class ReadTool implements Tool<ReadToolInput, ReadToolDetails> {
  readonly name = 'read_file';
  readonly description =
    "Read file contents from the filesystem. Output always includes line numbers " +
    "in format 'LINE_NUMBER|LINE_CONTENT' (1-indexed). Supports reading partial content " +
    "by specifying line offset and limit for large files.";
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file inside the workspace' },
      offset: { type: 'integer', description: 'Starting line number (1-indexed)' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['path'],
  };

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  renderCall = renderReadCall;

  renderResult(result: ToolResult<ReadToolDetails>, options = {}): string | undefined {
    if (!result.success || !result.details) return undefined;
    const { startLine, endLine, totalLines, shownLines, nextOffset, truncation } = result.details;
    const parts = [`read ${shownLines} lines (${startLine}-${endLine} of ${totalLines})`];
    if (nextOffset !== null) parts.push(`continue with offset=${nextOffset}`);
    if (truncation?.truncated) parts.push(`truncated ${truncation.shownChars}/${truncation.originalChars} chars`);
    return formatToolResultDisplay(parts.join('; '), result, {
      ...options,
      maxPreviewLines: 10,
      maxPreviewChars: 4000,
    });
  }

  async execute({ path: filePath, offset, limit }: ReadToolInput, context?: ToolExecutionContext): Promise<ToolResult<ReadToolDetails>> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      if (!this.operations.exists(resolved)) return { success: false, content: '', error: `File not found: ${filePath}` };

      const lines = this.operations.readFile(resolved).split('\n');
      const start = offset ? Math.max(0, offset - 1) : 0;
      if (start >= lines.length) {
        return { success: false, content: '', error: `Offset ${offset} is beyond end of file (${lines.length} lines total)` };
      }
      const end = limit ? Math.min(start + limit, lines.length) : lines.length;
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6, ' ')}|${line}`);
      const output = formatReadOutput(numbered, start, end, lines.length, Boolean(limit));
      return { success: true, content: output.content, details: output.details };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}

function formatReadOutput(
  numberedLines: string[],
  start: number,
  selectedEnd: number,
  totalLines: number,
  userLimited: boolean,
): { content: string; details: ReadToolDetails } {
  const fullOutput = numberedLines.join('\n');
  const nextOffset = selectedEnd + 1;
  const baseDetails = {
    totalLines,
    startLine: start + 1,
    endLine: selectedEnd,
    shownLines: numberedLines.length,
    userLimited,
    nextOffset: selectedEnd < totalLines ? nextOffset : null,
  };
  if (fullOutput.length <= READ_OUTPUT_MAX_CHARS) {
    if (userLimited && selectedEnd < totalLines) {
      const content = `${fullOutput}\n\n[${totalLines - selectedEnd} more lines in file. Use offset=${nextOffset} to continue.]`;
      return { content, details: baseDetails };
    }
    return { content: fullOutput, details: baseDetails };
  }

  const markerReserve = 220;
  const contentLimit = Math.max(0, READ_OUTPUT_MAX_CHARS - markerReserve);
  const outputLines: string[] = [];
  let outputLength = 0;
  for (const line of numberedLines) {
    const lineLength = line.length + (outputLines.length ? 1 : 0);
    if (outputLength + lineLength > contentLimit) break;
    outputLines.push(line);
    outputLength += lineLength;
  }

  if (outputLines.length === 0 && numberedLines.length > 0) {
    outputLines.push(numberedLines[0].slice(0, contentLimit));
  }

  const endLine = start + outputLines.length;
  const content = [
    outputLines.join('\n'),
    `[Showing lines ${start + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`,
  ].join('\n\n');
  return {
    content,
    details: {
      ...baseDetails,
      endLine,
      shownLines: outputLines.length,
      nextOffset: endLine < totalLines ? endLine + 1 : null,
      truncation: createToolOutputTruncation({
        original: fullOutput,
        shown: content,
        strategy: 'head',
        maxChars: READ_OUTPUT_MAX_CHARS,
      }),
    },
  };
}
