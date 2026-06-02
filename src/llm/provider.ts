import type { ConfigData } from '../config.js';
import { LLMProvider } from '../schema.js';

export type ProviderApiProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'google-generative-ai';

export type ProviderReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ProviderModel {
  readonly provider: LLMProvider;
  readonly providerName: string;
  readonly apiProtocol: ProviderApiProtocol;
  readonly id: string;
  readonly baseUrl: string;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly reasoning: {
    readonly supported: boolean;
    readonly defaultLevel?: Exclude<ProviderReasoningLevel, 'off'>;
  };
  readonly compatibility: {
    readonly googleThinkingConfig?: 'budget' | 'level';
  };
}

export interface ProviderAuth {
  readonly apiKey: string;
  readonly source: 'runtime' | 'config' | 'env';
}

export interface ProviderAuthResolverInput {
  readonly provider: LLMProvider;
  readonly providerName: string;
  readonly configApiKey?: string;
  readonly runtimeApiKey?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProviderRequestOptions {
  readonly reasoning?: ProviderReasoningLevel;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
  readonly sessionId?: string;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
}

export interface ProviderRuntimeContext {
  readonly model: ProviderModel;
  readonly auth: ProviderAuth;
  readonly requestOptions: ProviderRequestOptions;
}

const ENV_API_KEY_BY_PROVIDER: Record<LLMProvider, string[]> = {
  [LLMProvider.ANTHROPIC]: ['ANTHROPIC_API_KEY'],
  [LLMProvider.OPENAI]: ['OPENAI_API_KEY'],
  [LLMProvider.GOOGLE]: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

export function resolveProviderAuth({
  provider,
  configApiKey,
  runtimeApiKey,
  env = process.env,
}: ProviderAuthResolverInput): ProviderAuth {
  const runtime = normalizeApiKey(runtimeApiKey);
  if (runtime) return { apiKey: runtime, source: 'runtime' };

  const config = normalizeApiKey(configApiKey);
  if (config) return { apiKey: config, source: 'config' };

  for (const key of ENV_API_KEY_BY_PROVIDER[provider] ?? []) {
    const value = normalizeApiKey(env[key]);
    if (value) return { apiKey: value, source: 'env' };
  }

  throw new Error(`No API key configured for provider: ${provider}`);
}

export function createProviderModel({
  provider,
  providerName,
  model,
  baseUrl,
  contextWindowTokens = null,
}: {
  provider: LLMProvider;
  providerName: string;
  model: string;
  baseUrl: string;
  contextWindowTokens?: number | null;
}): ProviderModel {
  return {
    provider,
    providerName,
    apiProtocol: resolveApiProtocol(provider),
    id: model,
    baseUrl: normalizeBaseUrl(baseUrl),
    contextWindowTokens,
    maxOutputTokens: null,
    reasoning: resolveReasoning(provider, model),
    compatibility: resolveCompatibility(provider, model),
  };
}

export function createProviderRequestOptions(config: ConfigData): ProviderRequestOptions {
  return {
    timeoutMs: config.llm.retry.provider.timeoutMs,
    maxRetries: config.llm.retry.provider.maxRetries,
    maxRetryDelayMs: config.llm.retry.provider.maxRetryDelayMs,
  };
}

export function createProviderRuntimeContext({
  provider,
  providerName,
  config,
  runtimeApiKey,
}: {
  provider: LLMProvider;
  providerName: string;
  config: ConfigData;
  runtimeApiKey?: string;
}): ProviderRuntimeContext {
  const model = createProviderModel({
    provider,
    providerName,
    model: config.llm.model,
    baseUrl: config.llm.apiBase,
    contextWindowTokens: config.agent.contextWindowTokens,
  });
  const auth = resolveProviderAuth({
    provider,
    providerName,
    configApiKey: config.llm.apiKey,
    runtimeApiKey,
  });
  return {
    model,
    auth,
    requestOptions: createProviderRequestOptions(config),
  };
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === 'YOUR_API_KEY_HERE') return undefined;
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveApiProtocol(provider: LLMProvider): ProviderApiProtocol {
  if (provider === LLMProvider.ANTHROPIC) return 'anthropic-messages';
  if (provider === LLMProvider.OPENAI) return 'openai-chat-completions';
  return 'google-generative-ai';
}

function resolveReasoning(
  provider: LLMProvider,
  model: string,
): ProviderModel['reasoning'] {
  if (provider !== LLMProvider.GOOGLE) return { supported: false };
  const normalized = model.toLowerCase();
  if (/gemini-3(?:\.\d+)?-(?:flash|pro)/.test(normalized)) {
    return { supported: true };
  }
  if (/gemini-2\.5-(?:flash|pro)/.test(normalized)) {
    return { supported: true };
  }
  return { supported: false };
}

function resolveCompatibility(
  provider: LLMProvider,
  model: string,
): ProviderModel['compatibility'] {
  if (provider !== LLMProvider.GOOGLE) return {};
  const normalized = model.toLowerCase();
  if (/gemini-3(?:\.\d+)?-(?:flash|pro)/.test(normalized)) {
    return { googleThinkingConfig: 'level' };
  }
  if (/gemini-2\.5-(?:flash|pro)/.test(normalized)) {
    return { googleThinkingConfig: 'budget' };
  }
  return {};
}
