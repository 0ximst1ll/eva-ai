import { createAbortedToolResult, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult } from './base.js';
import { fileMutationQueue } from './file-mutation-queue.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';

export interface EditToolInput extends Record<string, unknown> {
  path: string;
  old_str: string;
  new_str: string;
}

function renderEditCall({ path }: EditToolInput): string {
  return `edit ${path || '...'}`;
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

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  renderCall = renderEditCall;

  async execute({ path: filePath, old_str, new_str }: EditToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      return await fileMutationQueue.run(resolved, async () => {
        if (isToolExecutionAborted(context)) return createAbortedToolResult();
        if (!this.operations.exists(resolved)) return { success: false, content: '', error: `File not found: ${filePath}` };

        const content = this.operations.readFile(resolved);
        const firstMatch = content.indexOf(old_str);
        if (firstMatch === -1) return { success: false, content: '', error: `Text not found in file: ${old_str}` };
        if (content.indexOf(old_str, firstMatch + old_str.length) !== -1) {
          return {
            success: false,
            content: '',
            error: 'Text is not unique in file. Read the file and provide a more specific old_str.',
          };
        }

        this.operations.writeFile(
          resolved,
          content.slice(0, firstMatch) + new_str + content.slice(firstMatch + old_str.length),
        );
        return { success: true, content: `Successfully edited ${resolved}` };
      });
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
