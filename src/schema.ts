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

export type LlmMessage =
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

export type Message = LlmMessage;

export interface InternalAgentMessage {
    role: 'internal';
    kind: string;
    content?: string;
    metadata?: Record<string, unknown>;
}

export interface CustomAgentMessages {
    internal: InternalAgentMessage;
}

export type AgentMessage = LlmMessage | CustomAgentMessages[keyof CustomAgentMessages];

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
    details?: Record<string, unknown>;
    contentTruncated?: boolean;
    originalContentLength?: number;
    maxContentLength?: number;
    errorTruncated?: boolean;
    originalErrorLength?: number;
    maxErrorLength?: number;
}

export type AgentSessionEvent =
    | { type: 'agent_start' }
    | { type: 'agent_end'; messages: AgentMessage[]; finalContent: string }
    | { type: 'message_start'; step: number; maxSteps?: number | null }
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
