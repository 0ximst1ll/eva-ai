import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolExecutionContext, ToolResult } from './base.js';
import { fileMutationQueue } from './file-mutation-queue.js';
import { resolveWorkspacePath } from './path-utils.js';

export interface WriteToolInput extends Record<string, unknown> {
  path: string;
  content: string;
}

export class WriteTool implements Tool<WriteToolInput> {
  readonly name = 'write_file';
  readonly description =
    'Write content to a file inside the workspace. Will overwrite existing files completely. Read existing files first.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file inside the workspace' },
      content: { type: 'string', description: 'Complete content to write' },
    },
    required: ['path', 'content'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, content }: WriteToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      return await fileMutationQueue.run(resolved, async () => {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return { success: true, content: `Successfully wrote to ${resolved}` };
      });
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
