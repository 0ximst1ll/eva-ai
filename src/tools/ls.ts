import { createAbortedToolResult, formatToolResultDisplay, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult, type ToolResultDetails } from './base.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS, formatToolOutputTruncationSummary, truncateHeadByChars, type ToolOutputTruncationDetails } from './truncate.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);

export interface LsToolInput extends Record<string, unknown> {
  path?: string;
}

export interface ListToolDetails extends ToolResultDetails {
  resultCount: number;
  truncation?: ToolOutputTruncationDetails;
}

function renderLsCall({ path = '.' }: LsToolInput): string {
  return `ls ${path || '.'}`;
}

export class LsTool implements Tool<LsToolInput, ListToolDetails> {
  readonly name = 'ls';
  readonly description = 'List files and directories under a workspace path. Prefer this over bash ls/find.';
  readonly promptSnippet = 'List directory contents';
  readonly promptGuidelines = [
    'Use ls instead of bash ls for directory inspection.',
  ];
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

  renderCall = renderLsCall;

  renderResult(result: ToolResult<ListToolDetails>, options = {}): string | undefined {
    if (!result.success || !result.details) return undefined;
    const { resultCount, truncation } = result.details;
    const parts = [`${resultCount} entries`];
    if (truncation?.truncated) parts.push(formatToolOutputTruncationSummary(truncation));
    return formatToolResultDisplay(parts.join('; '), result, {
      ...options,
      maxPreviewLines: 20,
      maxPreviewChars: 4000,
    });
  }

  async execute({ path: targetPath = '.' }: LsToolInput, context?: ToolExecutionContext): Promise<ToolResult<ListToolDetails>> {
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
      const truncated = truncateHeadByChars(
        output,
        DEFAULT_TOOL_OUTPUT_MAX_CHARS,
        `[Directory listing truncated: original=${output.length} chars. Use a narrower path.]`,
      );
      return {
        success: true,
        content: truncated.content,
        details: {
          resultCount: entries.length,
          truncation: truncated.truncation,
        },
      };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
