export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
}

export interface FunctionCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolCall {
    id: string;
    type: string; // "function"
    function: FunctionCall;
    providerMetadata?: {
        google?: {
            thoughtSignature?: string;
        };
    };
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

export type LLMStreamEvent =
    | { type: 'thinking_delta'; text: string }
    | { type: 'content_delta'; text: string }
    | { type: 'tool_call'; tool_call: ToolCall }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'done'; response: LLMResponse };

export interface ToolExecutionResult {
    toolCallId: string;
    toolName: string;
    success: boolean;
    content: string;
    error?: string;
}

export type AgentSessionEvent =
    | { type: 'message_start'; step: number; maxSteps: number }
    | { type: 'thinking_delta'; text: string }
    | { type: 'content_delta'; text: string }
    | { type: 'tool_call'; tool_call: ToolCall }
    | { type: 'tool_result'; result: ToolExecutionResult }
    | { type: 'usage'; usage: TokenUsage }
    | {
        type: 'message_end';
        step: number;
        elapsedMs: number;
        totalElapsedMs: number;
        response: LLMResponse;
    }
    | { type: 'error'; message: string; error?: string };
