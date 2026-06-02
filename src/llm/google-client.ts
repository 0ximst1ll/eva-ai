// Google Gemini LLM client — mirrors anthropic-client.ts / openai-client.ts

import { GoogleGenAI } from '@google/genai';
import type {
  GenerateContentResponse,
  Content,
  Part,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
  HttpOptions,
} from '@google/genai';
import type {
  LLMResponse,
  LLMStreamEvent,
  Message,
  TokenUsage,
  ToolCall,
} from '../schema.js';
import type { Tool } from '../tools/base.js';
import { RetryConfig, withRetry } from '../retry.js';
import { LLMClientBase, type LLMRequestOptions } from './base.js';
import {
  createProviderModel,
  type ProviderModel,
  type ProviderReasoningLevel,
  type ProviderRequestOptions,
} from './provider.js';
import { LLMProvider } from '../schema.js';

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

type GoogleThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
type GoogleBudgetReasoningLevel = Exclude<ProviderReasoningLevel, 'off' | 'xhigh'>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException('LLM request aborted', 'AbortError');
}

export class GoogleClient extends LLMClientBase {
  private readonly client: GoogleGenAI;
  private readonly providerModel: ProviderModel;
  private readonly requestOptions: ProviderRequestOptions;

  constructor(
    apiKey: string,
    apiBase: string = '',
    model: string = 'gemini-2.0-flash',
    retryConfig?: RetryConfig,
    providerModel?: ProviderModel,
    requestOptions: ProviderRequestOptions = {},
  ) {
    super(apiKey, apiBase, model, retryConfig);
    this.providerModel = providerModel ?? createProviderModel({
      provider: LLMProvider.GOOGLE,
      providerName: 'google',
      model,
      baseUrl: apiBase,
    });
    this.requestOptions = requestOptions;
    const httpOptions = this._buildHttpOptions();
    this.client = new GoogleGenAI({
      apiKey,
      ...(httpOptions ? { httpOptions } : {}),
    });
  }

  /**
   * 核心 API 请求 — 提取出来以便 withRetry 可以包装它
   */
  protected _buildHttpOptions(): HttpOptions | undefined {
    const httpOptions: HttpOptions = {};

    if (this.apiBase) httpOptions.baseUrl = this.apiBase;
    if (this.requestOptions.headers) httpOptions.headers = this.requestOptions.headers;
    if (this.requestOptions.timeoutMs !== undefined) {
      httpOptions.timeout = this.requestOptions.timeoutMs;
    }
    if (this.requestOptions.maxRetries !== undefined) {
      httpOptions.retryOptions = { attempts: this.requestOptions.maxRetries + 1 };
    }

    return Object.keys(httpOptions).length ? httpOptions : undefined;
  }

  protected _buildConfig(
    systemInstruction: string | null,
    tools?: Tool[] | null,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    if (systemInstruction) {
      config['systemInstruction'] = systemInstruction;
    }

    if (this.requestOptions.temperature !== undefined) {
      config['temperature'] = this.requestOptions.temperature;
    }

    if (this.requestOptions.maxTokens !== undefined) {
      config['maxOutputTokens'] = this.requestOptions.maxTokens;
    }

    const thinkingConfig = this._buildThinkingConfig();
    if (thinkingConfig) {
      config['thinkingConfig'] = thinkingConfig;
    }

    if (tools?.length) {
      config['tools'] = [{ functionDeclarations: tools.map(toGoogleSchema) }];
    }

    return config;
  }

  private _buildThinkingConfig(): Record<string, unknown> | undefined {
    if (!this.providerModel.reasoning.supported) return undefined;

    const requestedReasoning = this.requestOptions.reasoning ?? this.providerModel.reasoning.defaultLevel;
    if (!requestedReasoning) return undefined;

    if (requestedReasoning === 'off') {
      return this._buildDisabledThinkingConfig();
    }

    if (this.providerModel.compatibility.googleThinkingConfig === 'level') {
      return {
        includeThoughts: true,
        thinkingLevel: this._mapThinkingLevel(requestedReasoning),
      };
    }

    if (this.providerModel.compatibility.googleThinkingConfig === 'budget') {
      return {
        includeThoughts: true,
        thinkingBudget: this._mapThinkingBudget(requestedReasoning),
      };
    }

    return {
      includeThoughts: true,
      thinkingBudget: -1,
    };
  }

  private _buildDisabledThinkingConfig(): Record<string, unknown> {
    if (this.providerModel.compatibility.googleThinkingConfig === 'level') {
      if (this._isGemini3ProModel()) return { thinkingLevel: 'LOW' };
      return { thinkingLevel: 'MINIMAL' };
    }

    return { thinkingBudget: 0 };
  }

  private _mapThinkingLevel(level: Exclude<ProviderReasoningLevel, 'off'>): GoogleThinkingLevel {
    if (this._isGemini3ProModel()) {
      return level === 'minimal' || level === 'low' ? 'LOW' : 'HIGH';
    }

    switch (level) {
      case 'minimal':
        return 'MINIMAL';
      case 'low':
        return 'LOW';
      case 'medium':
        return 'MEDIUM';
      case 'high':
      case 'xhigh':
        return 'HIGH';
    }
  }

  private _mapThinkingBudget(level: Exclude<ProviderReasoningLevel, 'off'>): number {
    const budgetLevel = level === 'xhigh' ? 'high' : level;
    const model = this.model.toLowerCase();

    if (model.includes('2.5-pro')) {
      return this._budgetForLevel(budgetLevel, {
        minimal: 128,
        low: 2048,
        medium: 8192,
        high: 32768,
      });
    }

    if (model.includes('2.5-flash-lite')) {
      return this._budgetForLevel(budgetLevel, {
        minimal: 512,
        low: 2048,
        medium: 8192,
        high: 24576,
      });
    }

    if (model.includes('2.5-flash')) {
      return this._budgetForLevel(budgetLevel, {
        minimal: 128,
        low: 2048,
        medium: 8192,
        high: 24576,
      });
    }

    return -1;
  }

  private _budgetForLevel(
    level: GoogleBudgetReasoningLevel,
    budgets: Record<GoogleBudgetReasoningLevel, number>,
  ): number {
    return budgets[level];
  }

  private _isGemini3ProModel(): boolean {
    return /gemini-3(?:\.\d+)?-pro/.test(this.model.toLowerCase());
  }

  private async _makeApiRequest(
    systemInstruction: string | null,
    contents: Content[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): Promise<GenerateContentResponse> {
    throwIfAborted(options?.signal);
    const config = this._buildConfig(systemInstruction, tools);

    return this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });
  }

  private async _makeApiStreamRequest(
    systemInstruction: string | null,
    contents: Content[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    throwIfAborted(options?.signal);
    const config = this._buildConfig(systemInstruction, tools);

    return this.client.models.generateContentStream({
      model: this.model,
      contents,
      config,
    });
  }

  private async _makeCountTokensRequest(
    systemInstruction: string | null,
    contents: Content[],
    tools?: Tool[] | null,
  ): Promise<number | null> {
    const config: Record<string, unknown> = {};

    if (systemInstruction) {
      config['systemInstruction'] = systemInstruction;
    }

    if (tools?.length) {
      config['tools'] = [{ functionDeclarations: tools.map(toGoogleSchema) }];
    }

    const response = await this.client.models.countTokens({
      model: this.model,
      contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }],
      config,
    });
    return typeof response.totalTokens === 'number' ? response.totalTokens : null;
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
            const part: Part = {
              functionCall: {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments,
              },
            };
            if (tc.providerMetadata?.google?.thoughtSignature) {
              part.thoughtSignature = tc.providerMetadata.google.thoughtSignature;
            }
            parts.push(part);
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
  protected _parseResponse(response: GenerateContentResponse): LLMResponse {
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
            providerMetadata: part.thoughtSignature
              ? { google: { thoughtSignature: part.thoughtSignature } }
              : undefined,
          });
        }
      }
    }

    // 解析 token 用量
    const usage = this._parseUsage(response.usageMetadata);

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

  async generate(
    messages: Message[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const { systemInstruction, contents } = this._prepareRequest(messages, tools) as {
      systemInstruction: string | null;
      contents: Content[];
    };

    let response: GenerateContentResponse;

    if (this.retryConfig.enabled) {
      const wrapped = withRetry(
        (si: string | null, c: Content[], t?: Tool[] | null) =>
          this._makeApiRequest(si, c, t, options),
        this.retryConfig,
        this.retryCallback ?? undefined,
      );
      response = await wrapped(systemInstruction, contents, tools);
    } else {
      response = await this._makeApiRequest(systemInstruction, contents, tools, options);
    }

    return this._parseResponse(response);
  }

  async countTokens(messages: Message[], tools?: Tool[] | null): Promise<number | null> {
    const { systemInstruction, contents } = this._prepareRequest(messages, tools) as {
      systemInstruction: string | null;
      contents: Content[];
    };

    try {
      if (this.retryConfig.enabled) {
        const wrapped = withRetry(
          (si: string | null, c: Content[], t?: Tool[] | null) =>
            this._makeCountTokensRequest(si, c, t),
          this.retryConfig,
          this.retryCallback ?? undefined,
        );
        return await wrapped(systemInstruction, contents, tools);
      }
      return await this._makeCountTokensRequest(systemInstruction, contents, tools);
    } catch {
      return null;
    }
  }

  async *generateStream(
    messages: Message[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    const { systemInstruction, contents } = this._prepareRequest(messages, tools) as {
      systemInstruction: string | null;
      contents: Content[];
    };

    let stream: AsyncGenerator<GenerateContentResponse>;
    if (this.retryConfig.enabled) {
      const wrapped = withRetry(
        (si: string | null, c: Content[], t?: Tool[] | null) => this._makeApiStreamRequest(si, c, t, options),
        this.retryConfig,
        this.retryCallback ?? undefined,
      );
      stream = await wrapped(systemInstruction, contents, tools);
    } else {
      stream = await this._makeApiStreamRequest(systemInstruction, contents, tools, options);
    }

    let fullContent = '';
    let fullThinking = '';
    let finishReason = 'stop';
    let usage: TokenUsage | undefined;
    const toolCalls: ToolCall[] = [];
    const seenToolCalls = new Set<string>();

    for await (const chunk of stream) {
      throwIfAborted(options?.signal);
      usage = this._parseUsage(chunk.usageMetadata) ?? usage;
      if (usage) {
        yield { type: 'usage', usage };
      }

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) {
        finishReason =
          candidate.finishReason === 'STOP' ? 'stop' : candidate.finishReason.toLowerCase();
      }

      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought && part.text) {
          fullThinking += part.text;
          yield { type: 'thinking_delta', text: part.text };
          continue;
        }

        if (part.text) {
          fullContent += part.text;
          yield { type: 'content_delta', text: part.text };
          continue;
        }

        if (part.functionCall) {
          const fc = part.functionCall;
          const toolCall: ToolCall = {
            id: fc.id ?? `call_${fc.name}_${Date.now()}`,
            type: 'function',
            function: {
              name: fc.name ?? '',
              arguments: (fc.args ?? {}) as Record<string, unknown>,
            },
            providerMetadata: part.thoughtSignature
              ? { google: { thoughtSignature: part.thoughtSignature } }
              : undefined,
          };
          const key = `${toolCall.id}:${toolCall.function.name}:${JSON.stringify(toolCall.function.arguments)}`;
          if (!seenToolCalls.has(key)) {
            seenToolCalls.add(key);
            toolCalls.push(toolCall);
            yield { type: 'tool_call', tool_call: toolCall };
          }
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

  private _parseUsage(meta?: GenerateContentResponseUsageMetadata): TokenUsage | undefined {
    if (!meta) return undefined;
    const promptTokens = meta.promptTokenCount ?? 0;
    const completionTokens = meta.candidatesTokenCount ?? 0;
    const cachedTokens = meta.cachedContentTokenCount ?? 0;
    const thoughtsTokens = meta.thoughtsTokenCount ?? 0;
    return {
      prompt_tokens: promptTokens + cachedTokens,
      completion_tokens: completionTokens + thoughtsTokens,
      total_tokens: meta.totalTokenCount ?? (promptTokens + completionTokens),
    };
  }
}
