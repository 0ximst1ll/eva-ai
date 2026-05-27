import * as fs from 'node:fs';
import type { Tool, ToolExecutionContext, ToolResult } from './base.js';
import { resolveWorkspacePath } from './path-utils.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);

export interface LsToolInput extends Record<string, unknown> {
  path?: string;
}

export class LsTool implements Tool<LsToolInput> {
  readonly name = 'list_files';
  readonly description = 'List files and directories under a workspace path. Prefer this over bash ls/find.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative directory path inside the workspace. Defaults to workspace root.' },
    },
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: targetPath = '.' }: LsToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      if (!fs.existsSync(resolved)) return { success: false, content: '', error: `Path not found: ${targetPath}` };
      if (!fs.statSync(resolved).isDirectory()) return { success: false, content: '', error: `Not a directory: ${targetPath}` };

      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => !DEFAULT_IGNORES.has(entry.name))
        .map((entry) => `${entry.isDirectory() ? '[dir] ' : '[file]'} ${entry.name}`)
        .sort();
      return { success: true, content: entries.length ? entries.join('\n') : '(empty directory)' };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
