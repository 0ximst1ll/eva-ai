import { createAbortedToolResult, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult } from './base.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS, truncateHeadByChars } from './truncate.js';

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

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  async execute({ path: targetPath = '.' }: LsToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      if (!this.operations.exists(resolved)) return { success: false, content: '', error: `Path not found: ${targetPath}` };
      if (!this.operations.stat(resolved).isDirectory()) return { success: false, content: '', error: `Not a directory: ${targetPath}` };

      const entries = this.operations.readdir(resolved)
        .filter((entry) => !DEFAULT_IGNORES.has(entry.name))
        .map((entry) => `${entry.isDirectory() ? '[dir] ' : '[file]'} ${entry.name}`)
        .sort();
      if (!entries.length) return { success: true, content: '(empty directory)' };
      const output = entries.join('\n');
      return {
        success: true,
        content: truncateHeadByChars(
          output,
          DEFAULT_TOOL_OUTPUT_MAX_CHARS,
          `[Directory listing truncated: original=${output.length} chars. Use a narrower path.]`,
        ).content,
      };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
