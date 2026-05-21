import OpenAI from 'openai';
import type { LLMResponse, LLMStreamEvent, Message, TokenUsage, ToolCall } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { toOpenAISchema } from '../tools/base.js';
import { RetryConfig, withRetry } from '../retry.js';
import { LLMClientBase } from './base.js';


type ChatCompletion = OpenAI.Chat.ChatCompletion;
type ChatCompletionChunk = OpenAI.Chat.ChatCompletionChunk;

export class OpenAIClient extends LLMClientBase {

    private readonly client: OpenAI;

    constructor(
        apiKey: string,
        apiBase: string = '',
        model: string = '',
        retryConfig?: RetryConfig,
    ){
        super(apiKey, apiBase, model, retryConfig);
        this.client = new OpenAI({ apiKey, baseURL: apiBase });
    }


    private async _makeApiRequest(
        apiMessages: Record<string, unknown>[],
        tools?: Tool[] | null,
    ): Promise<ChatCompletion> {
        const params: Record<string, unknown> = {
            model: this.model,
            messages: apiMessages,
            //支持reasoning_split来分割思考内容
            extra_body: {reasoning_split: true},
        };

        if (tools?.length) params['tools'] = tools?.map(toOpenAISchema);

        return this.client.chat.completions.create(
            params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        ) as Promise<ChatCompletion>;
    }

    private async _makeApiStreamRequest(
        apiMessages: Record<string, unknown>[],
        tools?: Tool[] | null,
    ): Promise<AsyncGenerator<ChatCompletionChunk>> {
        const params: Record<string, unknown> = {
            model: this.model,
            messages: apiMessages,
            extra_body: { reasoning_split: true },
            stream: true,
            stream_options: { include_usage: true },
        };

        if (tools?.length) params['tools'] = tools.map(toOpenAISchema);

        return this.client.chat.completions.create(
            params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        ) as unknown as AsyncGenerator<ChatCompletionChunk>;
    }

    protected _convertMessages(messages: Message[]): [null, Record<string, unknown>[]] {
        const apiMessages: Record<string, unknown>[] = [];

        for(const msg of messages) {
            if(msg.role == 'system') {
                apiMessages.push({role: 'system', content: msg.content});
                continue;
            }
            
            if(msg.role == 'user') {
                apiMessages.push({role: 'user', content: msg.content});
                continue;
            }

            if(msg.role == 'assistant') {
                const am: Record<string, unknown> = {role: 'assistant'};
                if(msg.content) am['content'] = msg.content;

                if(msg.tool_calls?.length) {
                    am['tool_calls'] = msg.tool_calls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: JSON.stringify(tc.function.arguments),
                        },
                    }));
                }
                
                // 重要：保留 reasoning_content 以便兼容支持 reasoning_split 的 OpenAI-compatible 服务。

                // OpenAI 官方 Chat Completions 不会保留 reasoning items；这里是兼容接口扩展字段。
                if(msg.thinking) {
                    am['reasoning_content'] = msg.thinking;
                }

                apiMessages.push(am);
                continue;
            }

            if(msg.role == 'tool') {
                apiMessages.push({
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: msg.content,
                });
            }
        }

        return [null, apiMessages];
    }

    protected _prepareRequest(
        messages: Message[], 
        tools?: Tool[] | null
    ): Record<string, unknown> {
        
        const [, apiMessages] = this._convertMessages(messages);
        return { apiMessages, tools };
    }

    private _extractReasoningText(payload: Record<string, unknown>): string {
        // Align with pi-mono: OpenAI-compatible endpoints may stream reasoning under
        // reasoning_content, reasoning, or reasoning_text. Use the first non-empty field
        // to avoid duplicate thinking when gateways emit aliases.
        for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
            const value = payload[field];
            if (typeof value === 'string' && value.length > 0) return value;
        }
        return '';
    }

    private _parseResponse(response: ChatCompletion): LLMResponse {

        const message = response.choices[0].message;
        const textContent = message.content ?? '';

        //导出thinking内容
        const msgAny = message as unknown as Record<string, unknown>;
        const thinkingContent = this._extractReasoningText(msgAny);

        const toolCalls: ToolCall[] = [];
        if (message.tool_calls) {
            for(const tc of message.tool_calls) {
                if (tc.type !== 'function') continue; //新版本openai
                toolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.function.name,
                        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
                  },
                });
            }
        }

        let usage: TokenUsage | undefined;
        if (response.usage) {
            usage = {
                prompt_tokens: response.usage.prompt_tokens ?? 0,
                completion_tokens: response.usage.completion_tokens ?? 0,
                total_tokens: response.usage.total_tokens ?? 0,
            };
        }

        return {
            content: textContent,
            thinking: thinkingContent || undefined,
            tool_calls: toolCalls.length ? toolCalls : undefined,
            finish_reason: 'stop',
            usage,
        };
    }

    async generate(message: Message[], tools?: Tool[] | null): Promise<LLMResponse> {
        const { apiMessages } = this._prepareRequest(message, tools) as {
            apiMessages: Record<string, unknown>[];
        };

        let response: ChatCompletion;

        if (this.retryConfig.enabled) {
            const wrapped = withRetry(
                (am: Record<string, unknown>[], t?: Tool[] | null) => this._makeApiRequest(am, t),
                this.retryConfig,
                this.retryCallback ?? undefined,
            );

            response = await wrapped(apiMessages, tools);
        } else{
            response = await this._makeApiRequest(apiMessages, tools);

        }

        return this._parseResponse(response);

    }

    async *generateStream(
        messages: Message[],
        tools?: Tool[] | null,
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
        const { apiMessages } = this._prepareRequest(messages, tools) as {
            apiMessages: Record<string, unknown>[];
        };

        let stream: AsyncGenerator<ChatCompletionChunk>;
        if (this.retryConfig.enabled) {
            const wrapped = withRetry(
                (am: Record<string, unknown>[], t?: Tool[] | null) => this._makeApiStreamRequest(am, t),
                this.retryConfig,
                this.retryCallback ?? undefined,
            );
            stream = await wrapped(apiMessages, tools);
        } else {
            stream = await this._makeApiStreamRequest(apiMessages, tools);
        }

        let fullContent = '';
        let fullThinking = '';
        let finishReason = 'stop';
        let usage: TokenUsage | undefined;

        const toolCallState = new Map<number, { id?: string; name: string; argsText: string }>();
        const emittedToolCalls = new Set<string>();
        const toolCalls: ToolCall[] = [];

        for await (const chunk of stream) {
            if (chunk.usage) {
                usage = {
                    prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                    completion_tokens: chunk.usage.completion_tokens ?? 0,
                    total_tokens: chunk.usage.total_tokens ?? 0,
                };
                yield { type: 'usage', usage };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
                finishReason = choice.finish_reason === 'stop' ? 'stop' : String(choice.finish_reason);
            }

            const delta: Record<string, unknown> = (choice.delta ?? {}) as Record<string, unknown>;

            if (typeof delta['content'] === 'string' && delta['content']) {
                const text = delta['content'] as string;
                fullContent += text;
                yield { type: 'content_delta', text };
            }

            const thinkingText = this._extractReasoningText(delta);
            if (thinkingText) {
                fullThinking += thinkingText;
                yield { type: 'thinking_delta', text: thinkingText };
            }

            if (Array.isArray(delta['tool_calls'])) {
                for (const partialCall of delta['tool_calls'] as Array<Record<string, unknown>>) {
                    const index = Number(partialCall['index'] ?? 0);
                    const existing = toolCallState.get(index) ?? { name: '', argsText: '' };

                    if (typeof partialCall['id'] === 'string') existing.id = partialCall['id'];
                    const fn = partialCall['function'] as Record<string, unknown> | undefined;
                    if (fn) {
                        if (typeof fn['name'] === 'string') existing.name = fn['name'];
                        if (typeof fn['arguments'] === 'string') existing.argsText += fn['arguments'];
                    }
                    toolCallState.set(index, existing);
                }
            }
        }

        for (const [index, partial] of toolCallState.entries()) {
            if (!partial.name) continue;
            const callId = partial.id ?? `call_${index}`;
            const key = `${callId}:${partial.name}:${partial.argsText}`;
            if (emittedToolCalls.has(key)) continue;

            let parsedArgs: Record<string, unknown> = {};
            if (partial.argsText.trim()) {
                try {
                    parsedArgs = JSON.parse(partial.argsText) as Record<string, unknown>;
                } catch {
                    parsedArgs = {};
                }
            }

            const tc: ToolCall = {
                id: callId,
                type: 'function',
                function: {
                    name: partial.name,
                    arguments: parsedArgs,
                },
            };
            emittedToolCalls.add(key);
            toolCalls.push(tc);
            yield { type: 'tool_call', tool_call: tc };
        }

        const response: LLMResponse = {
            content: fullContent,
            thinking: fullThinking || undefined,
            tool_calls: toolCalls.length ? toolCalls : undefined,
            finish_reason: finishReason,
            usage,
        };

        yield { type: 'done', response };
        return response;
    }

        
}
