// Base tool types — mirrors eva_ai/tools/base.py
// Python uses abstract base class; TypeScript uses an interface.
// The `toSchema` / `toOpenaiSchema` methods are kept as standalone functions
// so tools don't need to carry them as instance methods.

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  details?: Record<string, unknown>;
}

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

export function createAbortedToolResult(): ToolResult {
  return { success: false, content: '', error: 'Operation aborted' };
}

export interface ToolDefinition<Input extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly metadata: ToolMetadata;
  prepareArguments?(args: Record<string, unknown>): Input;
  execute(args: Input, context?: ToolExecutionContext): Promise<ToolResult>;
}

// Base interface all tools must implement.
// Generic Input type defaults to Record<string, unknown> (like Python's **kwargs).
export interface Tool<Input extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly metadata?: ToolMetadata;
  execute(args: Input, context?: ToolExecutionContext): Promise<ToolResult>;
}

export function withToolMetadata<T extends Tool>(tool: T, metadata: ToolMetadata): T {
  return Object.assign(tool, { metadata });
}

export function createToolDefinition<Input extends Record<string, unknown>>(
  tool: Tool<Input>,
  metadata: ToolMetadata,
): ToolDefinition<Input> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    metadata,
    execute: (args, context) => tool.execute(args, context),
  };
}

export function toolFromDefinition<Input extends Record<string, unknown>>(
  definition: ToolDefinition<Input>,
): Tool<Input> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    metadata: definition.metadata,
    execute: (args, context) => definition.execute(definition.prepareArguments?.(args) ?? (args as Input), context),
  };
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
