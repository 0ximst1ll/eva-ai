// Anthropic LLM client — mirrors mini_agent/llm/anthropic_client.py

import Anthropic from '@anthropic-ai/sdk';
import type { LLMResponse, Message, TokenUsage, ToolCall } from '../schema.js';
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
}
