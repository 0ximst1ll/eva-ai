import * as path from 'node:path';
import { createAbortedToolResult, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult, type ToolResultDetails } from './base.js';
import { localFileToolOperations, type FileToolOperations } from './file-operations.js';
import { resolveWorkspacePath } from './path-utils.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS, truncateHeadByChars, type ToolOutputTruncationDetails } from './truncate.js';

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

export interface GrepToolInput extends Record<string, unknown> {
  pattern: string;
  path?: string;
  max_results?: number;
  case_sensitive?: boolean;
}

export interface SearchToolDetails extends ToolResultDetails {
  matchCount: number;
  maxResults: number;
  limitedByMaxResults: boolean;
  truncation?: ToolOutputTruncationDetails;
}

export class GrepTool implements Tool<GrepToolInput, SearchToolDetails> {
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

  constructor(
    private readonly workspaceDir: string = '.',
    private readonly operations: FileToolOperations = localFileToolOperations,
  ) {}

  async execute(
    { pattern, path: targetPath = '.', max_results = MAX_RESULTS, case_sensitive = true }: GrepToolInput,
    context?: ToolExecutionContext,
  ): Promise<ToolResult<SearchToolDetails>> {
    try {
      if (isToolExecutionAborted(context)) return createAbortedToolResult();
      const resolved = resolveWorkspacePath(this.workspaceDir, targetPath, {
        allowOutsideWorkspace: context?.allowOutsideWorkspace,
      });
      const limit = Math.max(1, Math.min(Number(max_results) || MAX_RESULTS, 1000));
      const stat = this.operations.stat(resolved);
      const files = stat.isDirectory() ? walkFiles(resolved, this.operations) : [resolved];
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
        if (isToolExecutionAborted(context)) return createAbortedToolResult();
        if (matches.length >= limit) break;
        let content: string;
        try {
          content = this.operations.readFile(file);
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (isToolExecutionAborted(context)) return createAbortedToolResult();
          if (!matcher(lines[i])) continue;
          matches.push(`${path.relative(this.workspaceDir, file)}:${i + 1}: ${lines[i]}`);
          if (matches.length >= limit) break;
        }
      }

      if (!matches.length) return { success: true, content: 'No matches found.' };

      const output = matches.join('\n');
      const limitedByMaxResults = matches.length >= limit;
      const baseDetails = {
        matchCount: matches.length,
        maxResults: limit,
        limitedByMaxResults,
      };
      const markerParts = [
        `Search output truncated: original=${output.length} chars.`,
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
