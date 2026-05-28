import * as fs from 'node:fs';
import type { Tool, ToolExecutionContext, ToolResult } from './base.js';
import { resolveWorkspacePath } from './path-utils.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS } from './truncate.js';

const READ_OUTPUT_MAX_CHARS = DEFAULT_TOOL_OUTPUT_MAX_CHARS;

export interface ReadToolInput extends Record<string, unknown> {
  path: string;
  offset?: number;
  limit?: number;
}

export class ReadTool implements Tool<ReadToolInput> {
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

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, offset, limit }: ReadToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      if (!fs.existsSync(resolved)) return { success: false, content: '', error: `File not found: ${filePath}` };

      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      const start = offset ? Math.max(0, offset - 1) : 0;
      if (start >= lines.length) {
        return { success: false, content: '', error: `Offset ${offset} is beyond end of file (${lines.length} lines total)` };
      }
      const end = limit ? Math.min(start + limit, lines.length) : lines.length;
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6, ' ')}|${line}`);
      return { success: true, content: formatReadOutput(numbered, start, end, lines.length, Boolean(limit)) };
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
): string {
  const fullOutput = numberedLines.join('\n');
  const nextOffset = selectedEnd + 1;
  if (fullOutput.length <= READ_OUTPUT_MAX_CHARS) {
    if (userLimited && selectedEnd < totalLines) {
      return `${fullOutput}\n\n[${totalLines - selectedEnd} more lines in file. Use offset=${nextOffset} to continue.]`;
    }
    return fullOutput;
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
  return [
    outputLines.join('\n'),
    `[Showing lines ${start + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`,
  ].join('\n\n');
}
