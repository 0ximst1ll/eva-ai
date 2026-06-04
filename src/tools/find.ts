import * as path from 'node:path';
import { createAbortedToolResult, formatToolResultDisplay, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult, type ToolResultDetails } from './base.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS, formatToolOutputTruncationSummary, truncateHeadByChars, type ToolOutputTruncationDetails } from './truncate.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);
const MAX_RESULTS = 200;

function walkFiles(root: string, operations: FileToolOperations): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = operations.readdir(current);
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

export interface FindToolDetails extends ToolResultDetails {
  resultCount: number;
  maxResults: number;
  limitedByMaxResults: boolean;
  truncation?: ToolOutputTruncationDetails;
}

function renderFindCall({ pattern, path = '.', max_results }: FindToolInput): string {
  const limit = max_results !== undefined ? ` limit ${max_results}` : '';
  return `find ${pattern || ''} in ${path || '.'}${limit}`;
}

export class FindTool implements Tool<FindToolInput, FindToolDetails> {
  readonly name = 'find_files';
  readonly description = 'Find files by filename substring or regular expression inside the workspace. Prefer this over bash find.';
  readonly promptSnippet = 'Find workspace files by filename or path pattern';
  readonly promptGuidelines = [
    'Use find_files instead of bash find for filename searches.',
    'Narrow path or max_results when a search may be broad.',
  ];
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Filename substring or JavaScript regular expression' },
      path: { type: 'string', description: 'Relative directory path inside the workspace. Defaults to workspace root.' },
      max_results: { type: 'integer', description: 'Maximum number of results. Default 200.' },
    },
    required: ['pattern'],
  };

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  renderCall = renderFindCall;

  renderResult(result: ToolResult<FindToolDetails>, options = {}): string | undefined {
    if (!result.success || !result.details) return undefined;
    const { resultCount, maxResults, limitedByMaxResults, truncation } = result.details;
    const parts = [`${resultCount} files`];
    if (limitedByMaxResults) parts.push(`stopped at max_results=${maxResults}`);
    if (truncation?.truncated) parts.push(formatToolOutputTruncationSummary(truncation));
    return formatToolResultDisplay(parts.join('; '), result, {
      ...options,
      maxPreviewLines: 20,
      maxPreviewChars: 4000,
    });
  }

  async execute(
    { pattern, path: targetPath = '.', max_results = MAX_RESULTS }: FindToolInput,
    context?: ToolExecutionContext,
  ): Promise<ToolResult<FindToolDetails>> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      const limit = Math.max(1, Math.min(Number(max_results) || MAX_RESULTS, 1000));
      let matcher: (file: string) => boolean;
      try {
        const re = new RegExp(pattern);
        matcher = (file) => re.test(path.basename(file)) || re.test(path.relative(resolved, file));
      } catch {
        matcher = (file) => path.basename(file).includes(pattern) || path.relative(resolved, file).includes(pattern);
      }

      const matches = walkFiles(resolved, this.operations).filter((file) => {
        if (isToolExecutionAborted(context)) return false;
        return matcher(file);
      }).slice(0, limit);
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const output = matches.map((file) => path.relative(this.workspaceDir, file)).sort().join('\n');
      if (!output) return { success: true, content: 'No matching files found.' };

      const limitedByMaxResults = matches.length >= limit;
      const baseDetails = {
        resultCount: matches.length,
        maxResults: limit,
        limitedByMaxResults,
      };
      const markerParts = [
        `Find output truncated: original=${output.length} chars.`,
        'Narrow path/pattern or lower max_results to reduce output.',
      ];
      if (limitedByMaxResults) markerParts.push(`Stopped after max_results=${limit}.`);
      const truncated = truncateHeadByChars(output, DEFAULT_TOOL_OUTPUT_MAX_CHARS, `[${markerParts.join(' ')}]`);
      if (!truncated.truncated && limitedByMaxResults) {
        return {
          success: true,
          content: `${output}\n\n[Stopped after max_results=${limit}. Narrow path/pattern to find more specific matches.]`,
          details: baseDetails,
        };
      }
      return {
        success: true,
        content: truncated.content,
        details: {
          ...baseDetails,
          truncation: truncated.truncation,
        },
      };
    } catch (err) {
      return { success: false, content: '', error: String(err) };
    }
  }
}
