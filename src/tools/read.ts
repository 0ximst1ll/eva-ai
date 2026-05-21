import * as fs from 'node:fs';
import type { Tool, ToolResult } from './base.js';
import { resolveWorkspacePath } from './path-utils.js';
import { truncateTextByTokens } from './truncate.js';

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

  async execute({ path: filePath, offset, limit }: ReadToolInput): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath);
      if (!fs.existsSync(resolved)) return { success: false, content: '', error: `File not found: ${filePath}` };

      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      const start = offset ? Math.max(0, offset - 1) : 0;
      const end = limit ? Math.min(start + limit, lines.length) : lines.length;
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6, ' ')}|${line}`);
      return { success: true, content: truncateTextByTokens(numbered.join('\n'), 32000).content };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
