// Anthropic LLM client — mirrors eva_ai/llm/anthropic_client.py

import Anthropic from '@anthropic-ai/sdk';
import type { LLMResponse, LLMStreamEvent, Message, TokenUsage, ToolCall } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { toAnthropicSchema } from '../tools/base.js';
import { RetryConfig, withRetry } from '../retry.js';
import { LLMClientBase } from './base.js';

type AnthropicMessage = Anthropic.Message;

export class AnthropicClient extends LLMClientBase {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    apiBase: string = '',
    model: string = '',
    retryConfig?: RetryConfig,
  ) {
    super(apiKey, apiBase, model, retryConfig);
    this.client = new Anthropic({
      baseURL: apiBase,
      apiKey,
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    });
  }

  // Core API request — extracted so withRetry can wrap it
  private async _makeApiRequest(
    systemMessage: string | null,
    apiMessages: Record<string, unknown>[],
    tools?: Tool[] | null,
  ): Promise<AnthropicMessage> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: 16384,
      messages: apiMessages,
    };

    if (systemMessage) params['system'] = systemMessage;
    if (tools?.length) params['tools'] = tools.map(toAnthropicSchema);

    return this.client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsNonStreaming,
    ) as Promise<AnthropicMessage>;
  }

  private async _makeApiStreamRequest(
    systemMessage: string | null,
    apiMessages: Record<string, unknown>[],
    tools?: Tool[] | null,
  ): Promise<AsyncGenerator<Record<string, unknown>>> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: 16384,
      messages: apiMessages,
      stream: true,
    };

    if (systemMessage) params['system'] = systemMessage;
    if (tools?.length) params['tools'] = tools.map(toAnthropicSchema);

    return this.client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsStreaming,
    ) as unknown as AsyncGenerator<Record<string, unknown>>;
  }

  protected _convertMessages(messages: Message[]): [string | null, Record<string, unknown>[]] {
    let systemMessage: string | null = null;
    const apiMessages: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content;
        continue;
      }

      if (msg.role === 'user') {
        apiMessages.push({ role: 'user', content: msg.content });
        continue;
      }

      if (msg.role === 'assistant') {
        // Build content blocks when thinking or tool_calls are present
        if (msg.thinking || msg.tool_calls?.length) {
          const blocks: Record<string, unknown>[] = [];

          if (msg.thinking) {
            blocks.push({ type: 'thinking', thinking: msg.thinking });
          }
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              blocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: tc.function.arguments,
              });
            }
          }
          apiMessages.push({ role: 'assistant', content: blocks });
        } else {
          apiMessages.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Anthropic uses user role with tool_result content blocks
        apiMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
        });
      }
    }

    return [systemMessage, apiMessages];
  }

  protected _prepareRequest(
    messages: Message[],
    tools?: Tool[] | null,
  ): Record<string, unknown> {
    const [systemMessage, apiMessages] = this._convertMessages(messages);
    return { systemMessage, apiMessages, tools };
  }

  private _parseResponse(response: AnthropicMessage): LLMResponse {
    let textContent = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'thinking') {
        thinkingContent += block.thinking;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    let usage: TokenUsage | undefined;
    if (response.usage) {
      const inputTokens = response.usage.input_tokens ?? 0;
      const outputTokens = response.usage.output_tokens ?? 0;
      const usageAny = response.usage as unknown as Record<string, number>;
      const cacheRead = usageAny['cache_read_input_tokens'] ?? 0;
      const cacheCreation = usageAny['cache_creation_input_tokens'] ?? 0;
      const totalInput = inputTokens + cacheRead + cacheCreation;
      usage = {
        prompt_tokens: totalInput,
        completion_tokens: outputTokens,
        total_tokens: totalInput + outputTokens,
      };
    }

    return {
      content: textContent,
      thinking: thinkingContent || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      finish_reason: response.stop_reason ?? 'stop',
      usage,
    };
  }

  async generate(messages: Message[], tools?: Tool[] | null): Promise<LLMResponse> {
    const { systemMessage, apiMessages } = this._prepareRequest(messages, tools) as {
      systemMessage: string | null;
      apiMessages: Record<string, unknown>[];
    };

    let response: AnthropicMessage;

    if (this.retryConfig.enabled) {
      const wrapped = withRetry(
        (sm: string | null, am: Record<string, unknown>[], t?: Tool[] | null) =>
          this._makeApiRequest(sm, am, t),
        this.retryConfig,
        this.retryCallback ?? undefined,
      );
      response = await wrapped(systemMessage, apiMessages, tools);
    } else {
      response = await this._makeApiRequest(systemMessage, apiMessages, tools);
    }

    return this._parseResponse(response);
  }

  async *generateStream(
    messages: Message[],
    tools?: Tool[] | null,
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    const { systemMessage, apiMessages } = this._prepareRequest(messages, tools) as {
      systemMessage: string | null;
      apiMessages: Record<string, unknown>[];
    };

    let stream: AsyncGenerator<Record<string, unknown>>;
    if (this.retryConfig.enabled) {
      const wrapped = withRetry(
        (sm: string | null, am: Record<string, unknown>[], t?: Tool[] | null) =>
          this._makeApiStreamRequest(sm, am, t),
        this.retryConfig,
        this.retryCallback ?? undefined,
      );
      stream = await wrapped(systemMessage, apiMessages, tools);
    } else {
      stream = await this._makeApiStreamRequest(systemMessage, apiMessages, tools);
    }

    let fullContent = '';
    let fullThinking = '';
    let finishReason = 'stop';
    let usage: TokenUsage | undefined;
    const toolCalls: ToolCall[] = [];
    const toolState = new Map<number, { id?: string; name?: string; inputText: string; inputObj?: Record<string, unknown> }>();

    for await (const event of stream) {
      const eventType = String(event['type'] ?? '');

      if (eventType === 'content_block_start') {
        const index = Number(event['index'] ?? 0);
        const contentBlock = (event['content_block'] ?? {}) as Record<string, unknown>;
        const blockType = String(contentBlock['type'] ?? '');

        if (blockType === 'tool_use') {
          toolState.set(index, {
            id: typeof contentBlock['id'] === 'string' ? contentBlock['id'] : undefined,
            name: typeof contentBlock['name'] === 'string' ? contentBlock['name'] : undefined,
            inputText: '',
            inputObj:
              contentBlock['input'] && typeof contentBlock['input'] === 'object'
                ? (contentBlock['input'] as Record<string, unknown>)
                : undefined,
          });
        }
        continue;
      }

      if (eventType === 'content_block_delta') {
        const index = Number(event['index'] ?? 0);
        const delta = (event['delta'] ?? {}) as Record<string, unknown>;
        const deltaType = String(delta['type'] ?? '');

        if (deltaType === 'text_delta' && typeof delta['text'] === 'string') {
          const text = delta['text'] as string;
          fullContent += text;
          yield { type: 'content_delta', text };
          continue;
        }

        if (deltaType === 'thinking_delta' && typeof delta['thinking'] === 'string') {
          const text = delta['thinking'] as string;
          fullThinking += text;
          yield { type: 'thinking_delta', text };
          continue;
        }

        if (deltaType === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
          const partial = toolState.get(index) ?? { inputText: '' };
          partial.inputText += delta['partial_json'] as string;
          toolState.set(index, partial as { id?: string; name?: string; inputText: string; inputObj?: Record<string, unknown> });
        }
        continue;
      }

      if (eventType === 'content_block_stop') {
        const index = Number(event['index'] ?? 0);
        const partial = toolState.get(index);
        if (!partial || !partial.name) continue;

        let args: Record<string, unknown> = partial.inputObj ?? {};
        if (partial.inputText.trim()) {
          try {
            args = JSON.parse(partial.inputText) as Record<string, unknown>;
          } catch {
            args = partial.inputObj ?? {};
          }
        }

        const tc: ToolCall = {
          id: partial.id ?? `toolu_${index}`,
          type: 'function',
          function: {
            name: partial.name,
            arguments: args,
          },
        };
        toolCalls.push(tc);
        yield { type: 'tool_call', tool_call: tc };
        continue;
      }

      if (eventType === 'message_delta') {
        const delta = (event['delta'] ?? {}) as Record<string, unknown>;
        if (typeof delta['stop_reason'] === 'string' && delta['stop_reason']) {
          finishReason = delta['stop_reason'] as string;
        }
        const usageAny = (event['usage'] ?? {}) as Record<string, number>;
        if (Object.keys(usageAny).length) {
          const inputTokens = usageAny['input_tokens'] ?? 0;
          const outputTokens = usageAny['output_tokens'] ?? 0;
          const cacheRead = usageAny['cache_read_input_tokens'] ?? 0;
          const cacheCreation = usageAny['cache_creation_input_tokens'] ?? 0;
          const totalInput = inputTokens + cacheRead + cacheCreation;
          usage = {
            prompt_tokens: totalInput,
            completion_tokens: outputTokens,
            total_tokens: totalInput + outputTokens,
          };
          yield { type: 'usage', usage };
        }
      }
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
