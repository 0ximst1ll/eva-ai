// LLM client wrapper — mirrors eva_ai/llm/llm_wrapper.py

import type { LLMResponse, LLMStreamEvent, LlmMessage } from '../schema.js';
import { LLMProvider } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { RetryConfig } from '../retry.js';
import { LLMClientBase, type LLMRequestOptions } from './base.js';
import { AnthropicClient } from './anthropic-client.js';
import { OpenAIClient } from './openai-client.js';
import { GoogleClient } from './google-client.js';
import type { ProviderAuth, ProviderModel, ProviderRequestOptions } from './provider.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

export class LLMClient {
  readonly provider: LLMProvider;
  readonly apiBase: string;
  readonly model: string;
  readonly providerModel?: ProviderModel;
  readonly providerRequestOptions?: ProviderRequestOptions;
  private readonly _client: LLMClientBase;

  get retryCallback(): ((error: Error, attempt: number) => void) | null {
    return this._client.retryCallback;
  }

  set retryCallback(value: ((error: Error, attempt: number) => void) | null) {
    this._client.retryCallback = value;
  }

  constructor({
    apiKey,
    provider = LLMProvider.ANTHROPIC,
    apiBase = 'https://api.minimaxi.com',
    model = 'MiniMax-M2.5',
    providerModel,
    providerAuth,
    providerRequestOptions,
    retryConfig,
  }: {
    apiKey: string;
    provider?: LLMProvider;
    apiBase?: string;
    model?: string;
    providerModel?: ProviderModel;
    providerAuth?: ProviderAuth;
    providerRequestOptions?: ProviderRequestOptions;
    retryConfig?: RetryConfig;
  }) {
    this.provider = providerModel?.provider ?? provider;
    this.model = providerModel?.id ?? model;
    this.providerModel = providerModel;
    this.providerRequestOptions = providerRequestOptions;
    const effectiveApiKey = providerAuth?.apiKey ?? apiKey;
    const effectiveApiBase = providerModel?.baseUrl ?? apiBase;
    const effectiveModel = providerModel?.id ?? model;

    // Normalize trailing slash
    const normalizedBase = effectiveApiBase.replace(/\/+$/, '');

    // Auto-append provider suffix for MiniMax domains
    const isMinimax = MINIMAX_DOMAINS.some((d) => normalizedBase.includes(d));
    let fullApiBase: string;

    if (isMinimax) {
      const stripped = normalizedBase.replace('/anthropic', '').replace('/v1', '');
      fullApiBase =
        this.provider === LLMProvider.ANTHROPIC ? `${stripped}/anthropic` : `${stripped}/v1`;
    } else {
      fullApiBase = normalizedBase;
    }

    this.apiBase = fullApiBase;

    if (this.provider === LLMProvider.ANTHROPIC) {
      this._client = new AnthropicClient(
        effectiveApiKey,
        fullApiBase,
        effectiveModel,
        retryConfig,
        providerRequestOptions,
      );
    } else if (this.provider === LLMProvider.OPENAI) {
      this._client = new OpenAIClient(
        effectiveApiKey,
        fullApiBase,
        effectiveModel,
        retryConfig,
        providerRequestOptions,
      );
    } else if (this.provider === LLMProvider.GOOGLE) {
      this._client = new GoogleClient(
        effectiveApiKey,
        fullApiBase,
        effectiveModel,
        retryConfig,
        providerModel,
        providerRequestOptions,
      );
    } else {
      throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  async generate(
    messages: LlmMessage[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    return this._client.generate(messages, tools, options);
  }

  async countTokens(messages: LlmMessage[], tools?: Tool[] | null): Promise<number | null> {
    return this._client.countTokens(messages, tools);
  }

  async *generateStream(
    messages: LlmMessage[],
    tools?: Tool[] | null,
    options?: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    return yield* this._client.generateStream(messages, tools, options);
  }
}
