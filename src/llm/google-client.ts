// Google Gemini LLM client — mirrors anthropic-client.ts / openai-client.ts

import { GoogleGenAI, Type } from '@google/genai';
import type {
  GenerateContentResponse,
  Content,
  Part,
  FunctionDeclaration,
} from '@google/genai';
import type { LLMResponse, Message, TokenUsage, ToolCall } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { RetryConfig, withRetry } from '../retry.js';
import { LLMClientBase } from './base.js';

/**
 * 将内部 Tool 转换为 Google Gemini FunctionDeclaration 格式
 */
function toGoogleSchema(tool: Tool): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as FunctionDeclaration['parameters'],
  };
}

export class GoogleClient extends LLMClientBase {
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    apiBase: string = '',
    model: string = 'gemini-2.0-flash',
    retryConfig?: RetryConfig,
  ) {
    super(apiKey, apiBase, model, retryConfig);
    this.client = new GoogleGenAI({
      apiKey,
      ...(apiBase ? { httpOptions: { baseUrl: apiBase } } : {}),
    });
  }

  /**
   * 核心 API 请求 — 提取出来以便 withRetry 可以包装它
   */
  private async _makeApiRequest(
    systemInstruction: string | null,
    contents: Content[],
    tools?: Tool[] | null,
  ): Promise<GenerateContentResponse> {
    const config: Record<string, unknown> = {
      thinkingConfig: { includeThoughts: true },
    };

    if (systemInstruction) {
      config['systemInstruction'] = systemInstruction;
    }

    if (tools?.length) {
      config['tools'] = [{ functionDeclarations: tools.map(toGoogleSchema) }];
    }

    return this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });
  }

  /**
   * 将内部 Message[] 转换为 Google Gemini 的 [systemInstruction, Content[]] 格式
   *
   * Google Gemini 使用 Content 数组，每个 Content 有 role ("user" | "model") 和 parts[]。
   * system 消息通过 config.systemInstruction 传递，而非 contents。
   * tool 结果通过 role="user" + functionResponse part 传递。
   */
  protected _convertMessages(messages: Message[]): [string | null, Record<string, unknown>[]] {
    let systemInstruction: string | null = null;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Part[] = [];

        // thinking 内容作为 thought part
        if (msg.thinking) {
          parts.push({ text: msg.thinking, thought: true });
        }

        // 文本内容
        if (msg.content) {
          parts.push({ text: msg.content });
        }

        // 函数调用
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments,
              },
            });
          }
        }

        if (parts.length) {
          contents.push({ role: 'model', parts });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Google Gemini 使用 user role + functionResponse part 来传递工具结果
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: msg.tool_call_id,
                name: msg.name ?? '',
                response: { output: msg.content },
              },
            },
          ],
        });
      }
    }

    return [systemInstruction, contents as unknown as Record<string, unknown>[]];
  }

  protected _prepareRequest(
    messages: Message[],
    tools?: Tool[] | null,
  ): Record<string, unknown> {
    const [systemInstruction, contents] = this._convertMessages(messages);
    return { systemInstruction, contents, tools };
  }

  /**
   * 解析 Google Gemini 响应为统一的 LLMResponse
   */
  private _parseResponse(response: GenerateContentResponse): LLMResponse {
    let textContent = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];

    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          // thought part — 思考内容
          thinkingContent += part.text;
        } else if (part.text) {
          // 普通文本
          textContent += part.text;
        } else if (part.functionCall) {
          const fc = part.functionCall;
          toolCalls.push({
            id: fc.id ?? `call_${fc.name}_${Date.now()}`,
            type: 'function',
            function: {
              name: fc.name ?? '',
              arguments: (fc.args ?? {}) as Record<string, unknown>,
            },
          });
        }
      }
    }

    // 解析 token 用量
    let usage: TokenUsage | undefined;
    if (response.usageMetadata) {
      const meta = response.usageMetadata;
      const promptTokens = meta.promptTokenCount ?? 0;
      const completionTokens = meta.candidatesTokenCount ?? 0;
      const cachedTokens = meta.cachedContentTokenCount ?? 0;
      const thoughtsTokens = meta.thoughtsTokenCount ?? 0;
      usage = {
        prompt_tokens: promptTokens + cachedTokens,
        completion_tokens: completionTokens + thoughtsTokens,
        total_tokens: meta.totalTokenCount ?? (promptTokens + completionTokens),
      };
    }

    // 映射 finishReason
    const finishReason = candidate?.finishReason ?? 'STOP';
    const normalizedFinishReason = finishReason === 'STOP' ? 'stop' : finishReason.toLowerCase();

    return {
      content: textContent,
      thinking: thinkingContent || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      finish_reason: normalizedFinishReason,
      usage,
    };
  }

  async generate(messages: Message[], tools?: Tool[] | null): Promise<LLMResponse> {
    const { systemInstruction, contents } = this._prepareRequest(messages, tools) as {
      systemInstruction: string | null;
      contents: Content[];
    };

    let response: GenerateContentResponse;

    if (this.retryConfig.enabled) {
      const wrapped = withRetry(
        (si: string | null, c: Content[], t?: Tool[] | null) =>
          this._makeApiRequest(si, c, t),
        this.retryConfig,
        this.retryCallback ?? undefined,
      );
      response = await wrapped(systemInstruction, contents, tools);
    } else {
      response = await this._makeApiRequest(systemInstruction, contents, tools);
    }

    return this._parseResponse(response);
  }
}
