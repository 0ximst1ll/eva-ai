import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './base.js';
import { resolveWorkspacePath } from './path-utils.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);
const MAX_RESULTS = 200;

function walkFiles(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  return results;
}

export interface FindToolInput extends Record<string, unknown> {
  pattern: string;
  path?: string;
  max_results?: number;
}

export class FindTool implements Tool<FindToolInput> {
  readonly name = 'find_files';
  readonly description = 'Find files by filename substring or regular expression inside the workspace. Prefer this over bash find.';
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Filename substring or JavaScript regular expression' },
      path: { type: 'string', description: 'Relative directory path inside the workspace. Defaults to workspace root.' },
      max_results: { type: 'integer', description: 'Maximum number of results. Default 200.' },
    },
    required: ['pattern'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ pattern, path: targetPath = '.', max_results = MAX_RESULTS }: FindToolInput): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath);
      const limit = Math.max(1, Math.min(Number(max_results) || MAX_RESULTS, 1000));
      let matcher: (file: string) => boolean;
      try {
        const re = new RegExp(pattern);
        matcher = (file) => re.test(path.basename(file)) || re.test(path.relative(resolved, file));
      } catch {
        matcher = (file) => path.basename(file).includes(pattern) || path.relative(resolved, file).includes(pattern);
      }

      const matches = walkFiles(resolved).filter(matcher).slice(0, limit);
      const content = matches.map((file) => path.relative(this.workspaceDir, file)).sort().join('\n');
      return { success: true, content: content || 'No matching files found.' };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
