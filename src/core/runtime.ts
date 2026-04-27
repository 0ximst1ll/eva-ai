import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config, type ConfigData } from '../config.js';
import { LLMProvider } from '../schema.js';
import { LLMClient } from '../llm/llm-client.js';
import { RetryConfig } from '../retry.js';
import type { Tool } from '../tools/base.js';
import { AgentSession } from './agent-session.js';
import { SessionManager } from './session-manager.js';

type SessionMode = 'memory' | 'jsonl';

type RuntimeDiagnosticType = 'info' | 'warning';

export interface RuntimeDiagnostic {
  type: RuntimeDiagnosticType;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RuntimeRetryEvent {
  error: Error;
  attempt: number;
  nextDelay: number;
}

export interface CreateRuntimeOptions {
  workspaceDir: string;
  configPath?: string;
  sessionMode?: SessionMode;
  createNewSession?: boolean;
  sessionId?: string;
  tools?: Tool[];
  onLlmRetry?: (event: RuntimeRetryEvent) => void;
}

export interface Runtime {
  config: ConfigData;
  configPath: string;
  llmClient: LLMClient;
  retryConfig: RetryConfig;
  systemPrompt: string;
  systemPromptPath: string | null;
  tools: Tool[];
  sessionManager: SessionManager;
  sessionId: string;
  session: AgentSession;
  diagnostics: RuntimeDiagnostic[];
}

export class RuntimeConfigNotFoundError extends Error {
  readonly configPath: string;
  readonly userConfigDir: string;

  constructor(configPath: string) {
    super(`Configuration file not found: ${configPath}`);
    this.name = 'RuntimeConfigNotFoundError';
    this.configPath = configPath;
    this.userConfigDir = path.join(os.homedir(), '.eva-ai', 'config');
  }
}

export class UnsupportedProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Unsupported provider: ${provider}`);
    this.name = 'UnsupportedProviderError';
    this.provider = provider;
  }
}

function resolveProvider(providerName: string): LLMProvider {
  const providerMap: Record<string, LLMProvider> = {
    anthropic: LLMProvider.ANTHROPIC,
    openai: LLMProvider.OPENAI,
    google: LLMProvider.GOOGLE,
  };

  const provider = providerMap[providerName.toLowerCase()];
  if (!provider) throw new UnsupportedProviderError(providerName);
  return provider;
}

function createRetryConfig(config: ConfigData): RetryConfig {
  return new RetryConfig({
    enabled: config.llm.retry.enabled,
    maxRetries: config.llm.retry.maxRetries,
    initialDelay: config.llm.retry.initialDelay,
    maxDelay: config.llm.retry.maxDelay,
    exponentialBase: config.llm.retry.exponentialBase,
  });
}

function loadSystemPrompt(config: ConfigData): {
  systemPrompt: string;
  systemPromptPath: string | null;
  diagnostic: RuntimeDiagnostic;
} {
  const systemPromptPath = Config.findConfigFile(config.agent.systemPromptPath);
  if (systemPromptPath && fs.existsSync(systemPromptPath)) {
    return {
      systemPrompt: fs.readFileSync(systemPromptPath, 'utf-8'),
      systemPromptPath,
      diagnostic: {
        type: 'info',
        code: 'system_prompt_loaded',
        message: `Loaded system prompt (from: ${systemPromptPath})`,
        details: { systemPromptPath },
      },
    };
  }

  return {
    systemPrompt: 'You are Eva AI, an intelligent assistant that can help users complete various tasks.',
    systemPromptPath: null,
    diagnostic: {
      type: 'warning',
      code: 'system_prompt_missing',
      message: 'System prompt not found, using default',
      details: { configuredPath: config.agent.systemPromptPath },
    },
  };
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const diagnostics: RuntimeDiagnostic[] = [];

  const configPath = options.configPath ?? Config.getDefaultConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new RuntimeConfigNotFoundError(configPath);
  }

  const config = Config.fromYaml(configPath);
  const retryConfig = createRetryConfig(config);
  const provider = resolveProvider(config.llm.provider);
  const llmClient = new LLMClient({
    apiKey: config.llm.apiKey,
    provider,
    apiBase: config.llm.apiBase,
    model: config.llm.model,
    retryConfig,
  });

  if (config.llm.retry.enabled) {
    llmClient.retryCallback = (error: Error, attempt: number) => {
      options.onLlmRetry?.({
        error,
        attempt,
        nextDelay: retryConfig.calculateDelay(attempt - 1),
      });
    };
    diagnostics.push({
      type: 'info',
      code: 'retry_enabled',
      message: `LLM retry mechanism enabled (max ${config.llm.retry.maxRetries} retries)`,
      details: { maxRetries: config.llm.retry.maxRetries },
    });
  }

  const { systemPrompt, systemPromptPath, diagnostic } = loadSystemPrompt(config);
  diagnostics.push(diagnostic);

  // Tool construction is intentionally centralized here. P1's next task will
  // replace this default with config-driven file/bash/note/skill/MCP loading.
  const tools = options.tools ?? [];

  const sessionManager = new SessionManager({
    workspaceDir,
    mode: options.sessionMode ?? 'jsonl',
  });

  let sessionId: string;
  if (options.sessionId) {
    const loaded = await sessionManager.loadSession(options.sessionId);
    sessionId = loaded ? options.sessionId : await sessionManager.createSession(systemPrompt, options.sessionId);
  } else if (options.createNewSession === false) {
    sessionId = (await sessionManager.loadLatestSession()) ?? (await sessionManager.createSession(systemPrompt));
  } else {
    sessionId = await sessionManager.createSession(systemPrompt);
  }

  const session = new AgentSession({
    llmClient,
    systemPrompt,
    tools,
    maxSteps: config.agent.maxSteps,
    sessionManager,
    sessionId,
  });

  return {
    config,
    configPath,
    llmClient,
    retryConfig,
    systemPrompt,
    systemPromptPath,
    tools,
    sessionManager,
    sessionId,
    session,
    diagnostics,
  };
}
