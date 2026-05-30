import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { ConfigData } from '../config.js';
import { LLMClient } from '../llm/llm-client.js';
import { RetryConfig } from '../retry.js';
import type { Tool, ToolMetadata } from '../tools/base.js';
import type { ToolRegistry } from '../tools/index.js';
import { AgentSession } from './agent-session.js';
import type { BeforeToolCallContext } from './agent-loop.js';
import {
  resolveToolPermission,
  type PermissionMode,
  type ToolPermissionDecision,
} from './permission-policy.js';
import { SessionManager } from './session-manager.js';
import {
  createRuntimeServices,
  type CreateRuntimeServicesOptions,
  type RuntimeResourceReloadResult,
  type RuntimeServices,
} from './runtime-services.js';

export type { RuntimeDiagnostic } from '../diagnostics.js';
export {
  isLikelyNetworkCommand,
  resolveToolPermission,
  type PermissionMode,
  type ToolPermissionDecision,
  type ToolPermissionRuleResult,
} from './permission-policy.js';
export {
  RuntimeConfigNotFoundError,
  UnsupportedProviderError,
  type RuntimeRetryEvent,
  type RuntimeResourceReloadResult,
  type RuntimeServices,
  type SessionMode,
} from './runtime-services.js';

export interface ToolConfirmationRequest {
  toolCall: BeforeToolCallContext['toolCall'];
  tool: Tool;
  args: Record<string, unknown>;
  metadata: ToolMetadata;
}

export type ToolPermissionHandlerResult = ToolPermissionDecision | boolean;

interface ToolGovernanceSessionContext {
  sessionManager: SessionManager;
  sessionId: string;
}

export interface CreateRuntimeOptions extends CreateRuntimeServicesOptions {
  createNewSession?: boolean;
  sessionId?: string;
  createSessionIfMissing?: boolean;
  maxSteps?: number | null;
  permissionMode?: PermissionMode;
  confirmToolCall?: (request: ToolConfirmationRequest) =>
    ToolPermissionHandlerResult | Promise<ToolPermissionHandlerResult>;
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
  services: RuntimeServices;
  reloadResources(): Promise<RuntimeResourceReloadResult>;
}

export class RuntimeSessionNotFoundError extends Error {
  readonly sessionId: string;
  readonly diagnostics: RuntimeDiagnostic[];

  constructor(sessionId: string, diagnostics: RuntimeDiagnostic[] = []) {
    super('Session not found: ' + sessionId);
    this.name = 'RuntimeSessionNotFoundError';
    this.sessionId = sessionId;
    this.diagnostics = diagnostics;
  }
}

export function normalizeToolPermissionDecision(result: ToolPermissionHandlerResult): ToolPermissionDecision {
  if (result === true) return 'allow';
  if (result === false) return 'deny';
  return result;
}

async function appendPermissionPendingEntry({
  context,
  reason,
  sessionContext,
  mode,
}: {
  context: BeforeToolCallContext & { tool: Tool & { metadata: ToolMetadata } };
  reason: string;
  sessionContext?: ToolGovernanceSessionContext;
  mode?: PermissionMode;
}): Promise<void> {
  if (!sessionContext) return;

  try {
    await sessionContext.sessionManager.appendInternalEntry({
      sessionId: sessionContext.sessionId,
      kind: 'permission_pending',
      content: reason,
      metadata: {
        toolName: context.tool.name,
        toolCallId: context.toolCall.id,
        riskLevel: context.tool.metadata.riskLevel,
        source: context.tool.metadata.source,
        category: context.tool.metadata.category,
        isReadOnly: context.tool.metadata.isReadOnly,
        requiresConfirmation: context.tool.metadata.requiresConfirmation ?? false,
        permissionMode: mode,
      },
    });
  } catch {
    // Permission checks should still fail closed even if diagnostic persistence fails.
  }
}

export function createToolGovernanceHook(
  config: ConfigData,
  options: CreateRuntimeOptions,
  sessionContext?: ToolGovernanceSessionContext,
) {
  return async (context: BeforeToolCallContext) => {
    const mode = options.permissionMode ?? config.tools.permissionMode ?? 'default';
    const result = resolveToolPermission({
      context,
      mode,
      workspaceDir: options.workspaceDir,
    });
    if (result.decision === 'allow') {
      return result.toolExecutionContext ? { toolExecutionContext: result.toolExecutionContext } : undefined;
    }

    if (result.decision === 'deny') {
      return {
        block: true,
        reason: result.reason ?? 'Tool execution denied',
      };
    }

    const governedContext = context as BeforeToolCallContext & { tool: Tool & { metadata: ToolMetadata } };
    const reason = result.reason ?? 'Tool permission required: ' + context.toolCall.function.name;
    if (!context.tool?.metadata || !options.confirmToolCall) {
      if (context.tool?.metadata) {
        await appendPermissionPendingEntry({ context: governedContext, reason, sessionContext, mode });
      }
      return {
        block: true,
        reason: !options.confirmToolCall
          ? `${reason}; no confirmation handler is available`
          : reason,
      };
    }

    const decision = normalizeToolPermissionDecision(
      await options.confirmToolCall({
        toolCall: context.toolCall,
        tool: context.tool,
        args: context.args,
        metadata: context.tool.metadata,
      }),
    );

    if (decision === 'ask') {
      const pendingReason = `${reason}; approval required but current mode cannot request it`;
      await appendPermissionPendingEntry({ context: governedContext, reason: pendingReason, sessionContext, mode });
      return {
        block: true,
        reason: pendingReason,
      };
    }

    if (decision === 'deny') {
      return {
        block: true,
        reason: 'Tool execution denied: ' + context.tool.name,
      };
    }

    return result.toolExecutionContext ? { toolExecutionContext: result.toolExecutionContext } : undefined;
  };
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  const services = await createRuntimeServices(options);
  const diagnostics = [...services.diagnostics];
  const {
    config,
    configPath,
    llmClient,
    retryConfig,
    systemPrompt,
    systemPromptPath,
    tools,
    toolRegistry,
    sessionManager,
    contextBuilder,
  } = services;

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
      throw new RuntimeSessionNotFoundError(options.sessionId, [
        ...diagnostics,
        ...sessionManager.getDiagnostics(),
      ]);
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
    maxSteps: options.maxSteps === undefined ? config.agent.maxSteps : options.maxSteps,
    contextBuilder,
    contextManager: services.contextManager,
    beforeToolCall: createToolGovernanceHook(config, options, { sessionManager, sessionId }),
    sessionManager,
    sessionId,
  });

  const runtime: Runtime = {
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
    services,
    async reloadResources(): Promise<RuntimeResourceReloadResult> {
      const result = services.reloadResources();
      runtime.systemPrompt = result.systemPrompt;
      runtime.systemPromptPath = result.systemPromptPath;
      runtime.diagnostics.push(...result.diagnostics);
      session.updateRuntimeResources({
        systemPrompt: result.systemPrompt,
        contextBuilder: result.contextBuilder,
      });
      return result;
    },
  };
  return runtime;
}
