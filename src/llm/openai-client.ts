import OpenAI from 'openai';
import type { LLMResponse, Message, TokenUsage, ToolCall } from '../schema';
import type { Tool } from '../tools/base';
import { toOpenAISchema } from '../tools/base';
import { RetryConfig, withRetry } from '../retry';
import { LLMClientBase } from './base';


type ChatCompletion = OpenAI.Chat.ChatCompletion;

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
                
                // 重要：保留 reasoning_details 以便交错思维。

                // 完整的 response_message（包括 reasoning_details）必须在下一轮传递回模型，以保持其思维链不被打断。
                if(msg.thinking) {
                    am['reasoning_details'] = [{text: msg.thinking}];
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

    private _parseResponse(response: ChatCompletion): LLMResponse {

        const message = response.choices[0].message;
        const textContent = message.content ?? '';

        //导出thinking内容
        let thinkingContent = '';
        const msgAny = message as unknown as Record<string, unknown>;
        if(Array.isArray(msgAny['reasoning_details'])) {
            for(const detail of msgAny['reasoning_details'] as Array<{text?: string}>) {
                if(detail.text) thinkingContent += detail.text;
            }
        }

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

        
}

