// File operation tools — mirrors eva_ai/tools/file_tools.py
// Python uses tiktoken; TypeScript uses gpt-tokenizer (same cl100k_base encoding).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { encode } from 'gpt-tokenizer';
import type { Tool, ToolResult } from './base.js';

function truncateTextByTokens(text: string, maxTokens: number): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;

  const ratio = tokens.length / text.length;
  const charsPerHalf = Math.floor((maxTokens / 2 / ratio) * 0.95);

  let head = text.slice(0, charsPerHalf);
  const lastNewlineHead = head.lastIndexOf('\n');
  if (lastNewlineHead > 0) head = head.slice(0, lastNewlineHead);

  let tail = text.slice(-charsPerHalf);
  const firstNewlineTail = tail.indexOf('\n');
  if (firstNewlineTail > 0) tail = tail.slice(firstNewlineTail + 1);

  return (
    head +
    `\n\n... [Content truncated: ${tokens.length} tokens -> ~${maxTokens} tokens limit] ...\n\n` +
    tail
  );
}

function resolvePath(workspaceDir: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(workspaceDir, targetPath);
}

// ============ ReadTool ============

interface ReadInput extends Record<string, unknown> {
  path: string;
  offset?: number;
  limit?: number;
}

export class ReadTool implements Tool<ReadInput> {
  readonly name = 'read_file';
  readonly description =
    "Read file contents from the filesystem. Output always includes line numbers " +
    "in format 'LINE_NUMBER|LINE_CONTENT' (1-indexed). Supports reading partial content " +
    "by specifying line offset and limit for large files. " +
    "You can call this tool multiple times in parallel to read different files simultaneously.";
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      offset: {
        type: 'integer',
        description: 'Starting line number (1-indexed). Use for large files to read from specific line',
      },
      limit: {
        type: 'integer',
        description: 'Number of lines to read. Use with offset for large files to read in chunks',
      },
    },
    required: ['path'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, offset, limit }: ReadInput): Promise<ToolResult> {
    try {
      const resolved = resolvePath(this.workspaceDir, filePath);
      if (!fs.existsSync(resolved)) {
        return { success: false, content: '', error: `File not found: ${filePath}` };
      }

      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');

      const start = offset ? Math.max(0, offset - 1) : 0;
      const end = limit ? Math.min(start + limit, lines.length) : lines.length;
      const selected = lines.slice(start, end);

      const numbered = selected.map((line, i) => {
        const lineNum = String(start + i + 1).padStart(6, ' ');
        return `${lineNum}|${line}`;
      });

      const content = truncateTextByTokens(numbered.join('\n'), 32000);
      return { success: true, content };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}

// ============ WriteTool ============

interface WriteInput extends Record<string, unknown> {
  path: string;
  content: string;
}

export class WriteTool implements Tool<WriteInput> {
  readonly name = 'write_file';
  readonly description =
    "Write content to a file. Will overwrite existing files completely. " +
    "For existing files, you should read the file first using read_file. " +
    "Prefer editing existing files over creating new ones unless explicitly needed.";
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      content: { type: 'string', description: 'Complete content to write (will replace existing content)' },
    },
    required: ['path', 'content'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, content }: WriteInput): Promise<ToolResult> {
    try {
      const resolved = resolvePath(this.workspaceDir, filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { success: true, content: `Successfully wrote to ${resolved}` };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}

// ============ EditTool ============

interface EditInput extends Record<string, unknown> {
  path: string;
  old_str: string;
  new_str: string;
}

export class EditTool implements Tool<EditInput> {
  readonly name = 'edit_file';
  readonly description =
    "Perform exact string replacement in a file. The old_str must match exactly " +
    "and appear uniquely in the file, otherwise the operation will fail. " +
    "You must read the file first before editing. Preserve exact indentation from the source.";
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      old_str: { type: 'string', description: 'Exact string to find and replace (must be unique in file)' },
      new_str: { type: 'string', description: 'Replacement string (use for refactoring, renaming, etc.)' },
    },
    required: ['path', 'old_str', 'new_str'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, old_str, new_str }: EditInput): Promise<ToolResult> {
    try {
      const resolved = resolvePath(this.workspaceDir, filePath);
      if (!fs.existsSync(resolved)) {
        return { success: false, content: '', error: `File not found: ${filePath}` };
      }

      const content = fs.readFileSync(resolved, 'utf-8');
      if (!content.includes(old_str)) {
        return { success: false, content: '', error: `Text not found in file: ${old_str}` };
      }

      fs.writeFileSync(resolved, content.split(old_str).join(new_str), 'utf-8');
      return { success: true, content: `Successfully edited ${resolved}` };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
