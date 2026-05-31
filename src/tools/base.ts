// Base tool types — mirrors eva_ai/tools/base.py
// Python uses abstract base class; TypeScript uses an interface.
// The `toSchema` / `toOpenaiSchema` methods are kept as standalone functions
// so tools don't need to carry them as instance methods.

export type ToolResultDetails = Record<string, unknown>;

export interface ToolResult<TDetails extends ToolResultDetails = ToolResultDetails> {
  success: boolean;
  content: string;
  error?: string;
  details?: TDetails;
}

export interface ToolRenderResultContext<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Input;
}

export interface ToolRenderResultOptions {
  readonly expanded?: boolean;
  readonly isPartial?: boolean;
}

export type ToolResultRenderer<
  Input extends Record<string, unknown> = Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
> = {
  bivarianceHack(
    result: ToolResult<TDetails>,
    options: ToolRenderResultOptions,
    context: ToolRenderResultContext<Input>,
  ): string | undefined;
}['bivarianceHack'];

// JSON Schema object type (what the LLM sees for parameters)
export type JsonSchema = Record<string, unknown>;

export type ToolCategory = 'read' | 'write' | 'bash' | 'mcp' | 'skill';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolSource = 'builtin' | 'mcp' | 'skill';

export interface ToolMetadata {
  readonly category: ToolCategory;
  readonly riskLevel: ToolRiskLevel;
  readonly source: ToolSource;
  readonly sourceName?: string;
  readonly isReadOnly: boolean;
  readonly isConcurrencySafe: boolean;
  readonly requiresConfirmation?: boolean;
}

export interface ToolExecutionContext {
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  readonly allowOutsideWorkspace?: boolean;
  readonly onUpdate?: (update: { content?: string; details?: Record<string, unknown> }) => void;
}

export function isToolExecutionAborted(context?: ToolExecutionContext): boolean {
  return context?.signal?.aborted ?? false;
}

export function createAbortedToolResult<TDetails extends ToolResultDetails = ToolResultDetails>(): ToolResult<TDetails> {
  return { success: false, content: '', error: 'Operation aborted' };
}

export interface ToolDefinition<
  Input extends Record<string, unknown> = Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly metadata: ToolMetadata;
  prepareArguments?(args: Record<string, unknown>): Input;
  execute(args: Input, context?: ToolExecutionContext): Promise<ToolResult<TDetails>>;
  renderResult?: ToolResultRenderer<Input, TDetails>;
}

// Base interface all tools must implement.
// Generic Input type defaults to Record<string, unknown> (like Python's **kwargs).
export interface Tool<
  Input extends Record<string, unknown> = Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly metadata?: ToolMetadata;
  execute(args: Input, context?: ToolExecutionContext): Promise<ToolResult<TDetails>>;
  renderResult?: ToolResultRenderer<Input, TDetails>;
}

export function withToolMetadata<T extends Tool>(tool: T, metadata: ToolMetadata): T {
  return Object.assign(tool, { metadata });
}

export function createToolDefinition<
  Input extends Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
>(
  tool: Tool<Input, TDetails>,
  metadata: ToolMetadata,
): ToolDefinition<Input, TDetails> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    metadata,
    execute: (args, context) => tool.execute(args, context),
    renderResult: tool.renderResult,
  };
}

export function toolFromDefinition<
  Input extends Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
>(
  definition: ToolDefinition<Input, TDetails>,
): Tool<Input, TDetails> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    metadata: definition.metadata,
    execute: (args, context) => definition.execute(definition.prepareArguments?.(args) ?? (args as Input), context),
    renderResult: definition.renderResult,
  };
}

export function renderToolResult<
  Input extends Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
>(
  tool: Tool<Input, TDetails>,
  result: ToolResult<TDetails>,
  context: Omit<ToolRenderResultContext<Input>, 'toolName'>,
  options: ToolRenderResultOptions = {},
): string | undefined {
  return tool.renderResult?.(
    result,
    options,
    {
      ...context,
      toolName: tool.name,
    },
  );
}

export interface FormatToolResultDisplayOptions {
  maxPreviewChars?: number;
  maxPreviewLines?: number;
  previewMode?: 'head' | 'tail';
  expanded?: boolean;
  moreLabel?: string;
}

export function formatToolResultDisplay(
  summary: string,
  result: Pick<ToolResult, 'content' | 'error'>,
  options: FormatToolResultDisplayOptions = {},
): string {
  const maxPreviewChars = options.expanded ? undefined : options.maxPreviewChars ?? 1200;
  const maxPreviewLines = options.maxPreviewLines;
  const previewMode = options.previewMode ?? 'head';
  const previewSource = result.content || result.error || '';
  const preview = previewSource.trim();
  if (!preview) return summary;

  let shown = preview;
  let omittedLines = 0;
  const lines = preview.split('\n');
  if (!options.expanded && maxPreviewLines !== undefined && lines.length > maxPreviewLines) {
    omittedLines = lines.length - maxPreviewLines;
    shown = (previewMode === 'tail' ? lines.slice(-maxPreviewLines) : lines.slice(0, maxPreviewLines)).join('\n');
  }

  if (maxPreviewChars !== undefined && shown.length > maxPreviewChars) {
    shown = `${shown.slice(0, maxPreviewChars).trimEnd()}\n[preview truncated: ${shown.length} chars shown, ${preview.length} chars total]`;
  }
  if (omittedLines > 0) {
    const label = options.moreLabel ?? (previewMode === 'tail' ? 'earlier lines' : 'more lines');
    const marker = `[... ${omittedLines} ${label}]`;
    shown = previewMode === 'tail' ? `${marker}\n${shown}` : `${shown}\n${marker}`;
  }
  return `${summary}\n\n${shown}`;
}

// Convert a Tool to Anthropic's tool schema format.
// Python: tool.to_schema()
export function toAnthropicSchema(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

// Convert a Tool to OpenAI's tool schema format.
// Python: tool.to_openai_schema()
export function toOpenAISchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
