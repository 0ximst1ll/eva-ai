import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config, type ConfigData } from '../config.js';
import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import { LLMProvider } from '../schema.js';
import { LLMClient } from '../llm/llm-client.js';
import { RetryConfig } from '../retry.js';
import type { Tool, ToolMetadata } from '../tools/base.js';
import { loadConfiguredTools, type ToolRegistry } from '../tools/index.js';
import { AgentSession } from './agent-session.js';
import type { BeforeToolCallContext } from './agent-loop.js';
import { SessionManager } from './session-manager.js';

type SessionMode = 'memory' | 'jsonl';

export type { RuntimeDiagnostic } from '../diagnostics.js';

export interface RuntimeRetryEvent {
  error: Error;
  attempt: number;
  nextDelay: number;
}

export interface ToolConfirmationRequest {
  toolCall: BeforeToolCallContext['toolCall'];
  tool: Tool;
  args: Record<string, unknown>;
  metadata: ToolMetadata;
}

export interface CreateRuntimeOptions {
  workspaceDir: string;
  configPath?: string;
  sessionMode?: SessionMode;
  sessionBaseDir?: string;
  createNewSession?: boolean;
  sessionId?: string;
  createSessionIfMissing?: boolean;
  tools?: Tool[];
  onLlmRetry?: (event: RuntimeRetryEvent) => void;
  confirmToolCall?: (request: ToolConfirmationRequest) => boolean | Promise<boolean>;
}

export interface Runtime {
  config: ConfigData;
  configPath: string;
  llmClient: LLMClient;
  retryConfig: RetryConfig;
  systemPrompt: string;
  systemPromptPath: string | null;
  tools: Tool[];
  toolRegistry: ToolRegistry | null;
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
    super('Unsupported provider: ' + provider);
    this.name = 'UnsupportedProviderError';
    this.provider = provider;
  }
}

export class RuntimeSessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('Session not found: ' + sessionId);
    this.name = 'RuntimeSessionNotFoundError';
    this.sessionId = sessionId;
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
      diagnostic: createDiagnostic({
        source: 'resource',
        level: 'info',
        code: 'system_prompt_loaded',
        message: `Loaded system prompt (from: ${systemPromptPath})`,
        details: { systemPromptPath },
      }),
    };
  }

  return {
    systemPrompt: 'You are Eva AI, an intelligent assistant that can help users complete various tasks.',
    systemPromptPath: null,
    diagnostic: createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'system_prompt_missing',
      message: 'System prompt not found, using default',
      details: { configuredPath: config.agent.systemPromptPath },
    }),
  };
}

function collectResourceDiagnostics(config: ConfigData): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  if (config.tools.enableNote) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'note_resource_not_loaded',
      message: 'Note resource is configured but not loaded yet',
      details: { enableNote: config.tools.enableNote },
    }));
  }

  if (config.tools.enableSkills) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'skills_resource_not_loaded',
      message: 'Skills are configured but the skills loader is not implemented yet',
      details: { enableSkills: config.tools.enableSkills, skillsDir: config.tools.skillsDir },
    }));
  }

  if (config.tools.enableMcp) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'mcp_resource_not_loaded',
      message: 'MCP is configured but the MCP loader is not implemented yet',
      details: { enableMcp: config.tools.enableMcp, mcpConfigPath: config.tools.mcpConfigPath },
    }));
  }

  return diagnostics;
}

function shouldConfirmTool(metadata: ToolMetadata, config: ConfigData): boolean {
  if (!config.tools.requireConfirmation) return false;
  if (metadata.requiresConfirmation) return true;
  return config.tools.confirmRiskLevels.includes(metadata.riskLevel);
}

function createToolGovernanceHook(config: ConfigData, options: CreateRuntimeOptions) {
  return async (context: BeforeToolCallContext) => {
    if (!context.tool?.metadata) return undefined;

    const metadata = context.tool.metadata;
    if (!shouldConfirmTool(metadata, config)) return undefined;

    if (!options.confirmToolCall) {
      return {
        block: true,
        reason: 'Tool requires confirmation but no confirmation handler is available: ' + context.tool.name,
      };
    }

    const approved = await options.confirmToolCall({
      toolCall: context.toolCall,
      tool: context.tool,
      args: context.args,
      metadata,
    });

    if (!approved) {
      return {
        block: true,
        reason: 'Tool execution rejected by user: ' + context.tool.name,
      };
    }

    return undefined;
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
  diagnostics.push(createDiagnostic({
    source: 'config',
    level: 'info',
    code: 'config_loaded',
    message: `Loaded config (from: ${configPath})`,
    details: { configPath },
  }));

  const retryConfig = createRetryConfig(config);
  const provider = resolveProvider(config.llm.provider);
  diagnostics.push(createDiagnostic({
    source: 'provider',
    level: 'info',
    code: 'provider_configured',
    message: `Configured ${config.llm.provider} provider (${config.llm.model})`,
    details: {
      provider: config.llm.provider,
      model: config.llm.model,
      apiBase: config.llm.apiBase,
    },
  }));

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
    diagnostics.push(createDiagnostic({
      source: 'provider',
      level: 'info',
      code: 'retry_enabled',
      message: `LLM retry mechanism enabled (max ${config.llm.retry.maxRetries} retries)`,
      details: { maxRetries: config.llm.retry.maxRetries },
    }));
  }

  const { systemPrompt, systemPromptPath, diagnostic } = loadSystemPrompt(config);
  diagnostics.push(diagnostic);
  diagnostics.push(...collectResourceDiagnostics(config));

  let tools: Tool[];
  let toolRegistry: ToolRegistry | null = null;
  if (options.tools) {
    tools = options.tools;
    diagnostics.push(createDiagnostic({
      source: 'tools',
      level: 'info',
      code: 'custom_tools_loaded',
      message: `Loaded ${tools.length} custom tool(s)`,
      details: { count: tools.length },
    }));
  } else {
    const loadedTools = await loadConfiguredTools({ config, workspaceDir });
    tools = loadedTools.tools;
    toolRegistry = loadedTools.registry;
    diagnostics.push(...loadedTools.diagnostics);
  }

  const sessionManager = new SessionManager({
    workspaceDir,
    mode: options.sessionMode ?? 'jsonl',
    baseDir: options.sessionBaseDir,
  });
  diagnostics.push(createDiagnostic({
    source: 'session',
    level: 'info',
    code: 'session_manager_ready',
    message: `Session manager ready (${options.sessionMode ?? 'jsonl'})`,
    details: {
      mode: options.sessionMode ?? 'jsonl',
      workspaceDir,
      baseDir: options.sessionBaseDir,
    },
  }));

  let sessionId: string;
  if (options.sessionId) {
    const loaded = await sessionManager.loadSession(options.sessionId);
    if (loaded) {
      sessionId = options.sessionId;
      diagnostics.push(createDiagnostic({
        source: 'session',
        level: 'info',
        code: 'session_loaded',
        message: `Loaded session: ${sessionId}`,
        details: { sessionId },
      }));
    } else if (options.createSessionIfMissing === false) {
      throw new RuntimeSessionNotFoundError(options.sessionId);
    } else {
      sessionId = await sessionManager.createSession(systemPrompt, options.sessionId);
      diagnostics.push(createDiagnostic({
        source: 'session',
        level: 'info',
        code: 'session_created',
        message: `Created session: ${sessionId}`,
        details: { sessionId, requestedSessionId: options.sessionId },
      }));
    }
  } else if (options.createNewSession === false) {
    const latestSessionId = await sessionManager.loadLatestSession();
    if (latestSessionId) {
      sessionId = latestSessionId;
      diagnostics.push(createDiagnostic({
        source: 'session',
        level: 'info',
        code: 'latest_session_loaded',
        message: `Loaded latest session: ${sessionId}`,
        details: { sessionId },
      }));
    } else {
      sessionId = await sessionManager.createSession(systemPrompt);
      diagnostics.push(createDiagnostic({
        source: 'session',
        level: 'info',
        code: 'session_created',
        message: `Created session: ${sessionId}`,
        details: { sessionId, reason: 'latest_session_missing' },
      }));
    }
  } else {
    sessionId = await sessionManager.createSession(systemPrompt);
    diagnostics.push(createDiagnostic({
      source: 'session',
      level: 'info',
      code: 'session_created',
      message: `Created session: ${sessionId}`,
      details: { sessionId },
    }));
  }

  const session = new AgentSession({
    llmClient,
    systemPrompt,
    tools,
    maxSteps: config.agent.maxSteps,
    beforeToolCall: createToolGovernanceHook(config, options),
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
    toolRegistry,
    sessionManager,
    sessionId,
    session,
    diagnostics,
  };
}
