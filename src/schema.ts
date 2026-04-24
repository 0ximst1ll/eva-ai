export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
}

export interface FunctionCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolCall {
    id: string;
    type: string; // "function"
    function: FunctionCall;
}

export type Message = 
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { 
        role: 'assistant';
        content: string;
        thinking?: string;
        tool_calls?: ToolCall[];
        }
    | { 
        role: 'tool';
        content: string;
        tool_call_id: string;
        name?: string;
    };

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface LLMResponse {
    content: string;
    thinking?: string;
    tool_calls?: ToolCall[];
    finish_reason: string;
    usage?: TokenUsage;
}