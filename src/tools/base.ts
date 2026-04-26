// Base tool types — mirrors mini_agent/tools/base.py
// Python uses abstract base class; TypeScript uses an interface.
// The `toSchema` / `toOpenaiSchema` methods are kept as standalone functions
// so tools don't need to carry them as instance methods.

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

// JSON Schema object type (what the LLM sees for parameters)
export type JsonSchema = Record<string, unknown>;

// Base interface all tools must implement.
// Generic Input type defaults to Record<string, unknown> (like Python's **kwargs).
export interface Tool<Input extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  execute(args: Input): Promise<ToolResult>;
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
