import * as path from 'node:path';
import { createAbortedToolResult, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult } from './base.js';
import { fileMutationQueue } from './file-mutation-queue.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';

export interface WriteToolInput extends Record<string, unknown> {
  path: string;
  content: string;
}

function renderWriteCall(input: WriteToolInput & { file_path?: string }): string {
  return `write ${input.file_path ?? input.path ?? '...'}`;
}

export class WriteTool implements Tool<WriteToolInput> {
  readonly name = 'write';
  readonly description =
    'Write content to a file inside the workspace. Will overwrite existing files completely. Read existing files first.';
  readonly promptSnippet = 'Create or overwrite files';
  readonly promptGuidelines = [
    'Use write only for new files or complete rewrites.',
    'Always provide both required arguments: path and complete content.',
    'Use edit for targeted changes to existing files.',
  ];
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file inside the workspace' },
      content: { type: 'string', description: 'Complete content to write' },
    },
    required: ['path', 'content'],
  };

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  renderCall = renderWriteCall;

  async execute({ path: filePath, content }: WriteToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, filePath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      return await fileMutationQueue.run(resolved, async () => {
        if (isToolExecutionAborted(context)) return createAbortedToolResult();
        this.operations.mkdir(path.dirname(resolved));
        this.operations.writeFile(resolved, content);
        return { success: true, content: `Successfully wrote to ${resolved}` };
      });
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
