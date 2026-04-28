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

export interface GrepToolInput extends Record<string, unknown> {
  pattern: string;
  path?: string;
  max_results?: number;
  case_sensitive?: boolean;
}

export class GrepTool implements Tool<GrepToolInput> {
  readonly name = 'grep_files';
  readonly description = 'Search text content in workspace files. Prefer this over bash grep/rg for code search.';
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or JavaScript regular expression to search for' },
      path: { type: 'string', description: 'Relative file or directory path inside the workspace. Defaults to workspace root.' },
      max_results: { type: 'integer', description: 'Maximum number of matching lines. Default 200.' },
      case_sensitive: { type: 'boolean', description: 'Whether matching is case-sensitive. Default true.' },
    },
    required: ['pattern'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ pattern, path: targetPath = '.', max_results = MAX_RESULTS, case_sensitive = true }: GrepToolInput): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath);
      const limit = Math.max(1, Math.min(Number(max_results) || MAX_RESULTS, 1000));
      const stat = fs.statSync(resolved);
      const files = stat.isDirectory() ? walkFiles(resolved) : [resolved];
      let matcher: (line: string) => boolean;
      try {
        const re = new RegExp(pattern, case_sensitive ? '' : 'i');
        matcher = (line) => re.test(line);
      } catch {
        const needle = case_sensitive ? pattern : pattern.toLowerCase();
        matcher = (line) => (case_sensitive ? line : line.toLowerCase()).includes(needle);
      }

      const matches: string[] = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!matcher(lines[i])) continue;
          matches.push(`${path.relative(this.workspaceDir, file)}:${i + 1}: ${lines[i]}`);
          if (matches.length >= limit) break;
        }
      }

      return { success: true, content: matches.length ? matches.join('\n') : 'No matches found.' };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
