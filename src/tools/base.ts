export interface ToolResult {
    success: boolean;
    content: string;
    error?: string;
}


export type JsonSchema = Record<string, unknown>;


//所有工具要实现的接口
export interface Tool<Input extends Record<string, unknown> = Record<string, unknown>> {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
    execute(input: Input): Promise<ToolResult>;
}

export function toAnthropicSchema(tool: Tool): Record<string, unknown> {
    return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
    };
}

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