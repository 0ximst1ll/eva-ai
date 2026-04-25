// LLM client wrapper — mirrors mini_agent/llm/llm_wrapper.py

import type { LLMResponse, Message } from '../schema.js';
import { LLMProvider } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { RetryConfig } from '../retry.js';
import { LLMClientBase } from './base.js';
import { AnthropicClient } from './anthropic-client.js';
import { OpenAIClient } from './openai-client.js';
import { GoogleClient } from './google-client.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

export class LLMClient {
  readonly provider: LLMProvider;
  readonly apiBase: string;
  readonly model: string;
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
    retryConfig,
  }: {
    apiKey: string;
    provider?: LLMProvider;
    apiBase?: string;
    model?: string;
    retryConfig?: RetryConfig;
  }) {
    this.provider = provider;
    this.model = model;

    // Normalize trailing slash
    const normalizedBase = apiBase.replace(/\/+$/, '');

    // Auto-append provider suffix for MiniMax domains
    const isMinimax = MINIMAX_DOMAINS.some((d) => normalizedBase.includes(d));
    let fullApiBase: string;

    if (isMinimax) {
      const stripped = normalizedBase.replace('/anthropic', '').replace('/v1', '');
      fullApiBase =
        provider === LLMProvider.ANTHROPIC ? `${stripped}/anthropic` : `${stripped}/v1`;
    } else {
      fullApiBase = normalizedBase;
    }

    this.apiBase = fullApiBase;

    if (provider === LLMProvider.ANTHROPIC) {
      this._client = new AnthropicClient(apiKey, fullApiBase, model, retryConfig);
    } else if (provider === LLMProvider.OPENAI) {
      this._client = new OpenAIClient(apiKey, fullApiBase, model, retryConfig);
    } else if (provider === LLMProvider.GOOGLE) {
      this._client = new GoogleClient(apiKey, fullApiBase, model, retryConfig);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async generate(messages: Message[], tools?: Tool[] | null): Promise<LLMResponse> {
    return this._client.generate(messages, tools);
  }
}
