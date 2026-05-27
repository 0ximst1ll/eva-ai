import * as fs from 'node:fs';
import type { Tool, ToolExecutionContext, ToolResult } from './base.js';
import { fileMutationQueue } from './file-mutation-queue.js';
import { resolveWorkspacePath } from './path-utils.js';

export interface EditToolInput extends Record<string, unknown> {
  path: string;
  old_str: string;
  new_str: string;
}

export class EditTool implements Tool<EditToolInput> {
  readonly name = 'edit_file';
  readonly description =
    'Perform exact string replacement in a workspace file. old_str must match exactly and appear uniquely.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file inside the workspace' },
      old_str: { type: 'string', description: 'Exact string to find and replace (must be unique)' },
      new_str: { type: 'string', description: 'Replacement string' },
    },
    required: ['path', 'old_str', 'new_str'],
  };

  constructor(private readonly workspaceDir: string = '.') {}

  async execute({ path: filePath, old_str, new_str }: EditToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      return await fileMutationQueue.run(resolved, async () => {
        if (!fs.existsSync(resolved)) return { success: false, content: '', error: `File not found: ${filePath}` };

        const content = fs.readFileSync(resolved, 'utf-8');
        const firstMatch = content.indexOf(old_str);
        if (firstMatch === -1) return { success: false, content: '', error: `Text not found in file: ${old_str}` };
        if (content.indexOf(old_str, firstMatch + old_str.length) !== -1) {
          return {
            success: false,
            content: '',
            error: 'Text is not unique in file. Read the file and provide a more specific old_str.',
          };
        }

        fs.writeFileSync(
          resolved,
          content.slice(0, firstMatch) + new_str + content.slice(firstMatch + old_str.length),
          'utf-8',
        );
        return { success: true, content: `Successfully edited ${resolved}` };
      });
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
