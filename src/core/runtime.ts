import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { ConfigData } from '../config.js';
import { LLMClient } from '../llm/llm-client.js';
import { RetryConfig } from '../retry.js';
import type { Tool, ToolMetadata } from '../tools/base.js';
import type { ToolRegistry } from '../tools/index.js';
import { AgentSession } from './agent-session.js';
import type { BeforeToolCallContext, BeforeToolCallHook, ToolExecutionHook } from './agent-loop.js';
import {
  resolveToolPermission,
  type PermissionMode,
  type ToolPermissionDecision,
  type ToolPermissionRuleResult,
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
  reason?: string;
  permissionMode?: PermissionMode;
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

type PermissionInternalEntryKind = 'permission_pending' | 'permission_denied';

async function appendPermissionInternalEntry({
  kind,
  context,
  reason,
  sessionContext,
  mode,
  decision,
  executionPolicy,
}: {
  kind: PermissionInternalEntryKind;
  context: BeforeToolCallContext & { tool: Tool & { metadata: ToolMetadata } };
  reason: string;
  sessionContext?: ToolGovernanceSessionContext;
  mode?: PermissionMode;
  decision?: ToolPermissionDecision;
  executionPolicy?: ToolPermissionRuleResult['executionPolicy'];
}): Promise<void> {
  if (!sessionContext) return;

  try {
    await sessionContext.sessionManager.appendInternalEntry({
      sessionId: sessionContext.sessionId,
      kind,
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
        decision,
        executionPolicy,
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
): BeforeToolCallHook {
  return async (context: BeforeToolCallContext) => {
    const mode = options.permissionMode ?? config.tools.permissionMode ?? 'default';
    const result = resolveToolPermission({
      context,
      mode,
      workspaceDir: options.workspaceDir,
    });
    const governedContext = context.tool?.metadata
      ? context as BeforeToolCallContext & { tool: Tool & { metadata: ToolMetadata } }
      : null;

    if (result.decision === 'allow') {
      return result.toolExecutionContext ? { toolExecutionContext: result.toolExecutionContext } : undefined;
    }

    if (result.decision === 'deny') {
      const reason = result.reason ?? 'Tool execution denied';
      if (governedContext) {
        await appendPermissionInternalEntry({
          kind: 'permission_denied',
          context: governedContext,
          reason,
          sessionContext,
          mode,
          decision: 'deny',
          executionPolicy: result.executionPolicy,
        });
      }
      return {
        block: true,
        reason,
      };
    }

    const reason = result.reason ?? 'Tool permission required: ' + context.toolCall.function.name;
    if (!context.tool?.metadata || !options.confirmToolCall) {
      if (governedContext) {
        await appendPermissionInternalEntry({
          kind: 'permission_pending',
          context: governedContext,
          reason,
          sessionContext,
          mode,
          decision: 'ask',
          executionPolicy: result.executionPolicy,
        });
      }
      return {
        block: true,
        reason: !options.confirmToolCall
          ? `${reason}; no confirmation handler is available`
          : reason,
      };
    }

    const confirmedContext = context as BeforeToolCallContext & { tool: Tool & { metadata: ToolMetadata } };
    const decision = normalizeToolPermissionDecision(
      await options.confirmToolCall({
        toolCall: context.toolCall,
        tool: context.tool,
        args: context.args,
        metadata: context.tool.metadata,
        reason,
        permissionMode: mode,
      }),
    );

    if (decision === 'ask') {
      const pendingReason = `${reason}; approval required but current mode cannot request it`;
      await appendPermissionInternalEntry({
        kind: 'permission_pending',
        context: confirmedContext,
        reason: pendingReason,
        sessionContext,
        mode,
        decision,
        executionPolicy: result.executionPolicy,
      });
      return {
        block: true,
        reason: pendingReason,
      };
    }

    if (decision === 'deny') {
      const deniedReason = 'Tool execution denied: ' + context.tool.name;
      await appendPermissionInternalEntry({
        kind: 'permission_denied',
        context: confirmedContext,
        reason: deniedReason,
        sessionContext,
        mode,
        decision,
        executionPolicy: result.executionPolicy,
      });
      return {
        block: true,
        reason: deniedReason,
      };
    }

    return result.toolExecutionContext ? { toolExecutionContext: result.toolExecutionContext } : undefined;
  };
}

export function createToolGovernanceExecutionHook(
  config: ConfigData,
  options: CreateRuntimeOptions,
  sessionContext?: ToolGovernanceSessionContext,
): ToolExecutionHook {
  return {
    name: 'permission_governance',
    beforeToolCall: createToolGovernanceHook(config, options, sessionContext),
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
    autoRetry: {
      enabled: config.llm.retry.enabled,
      maxRetries: config.llm.retry.maxRetries,
      initialDelayMs: config.llm.retry.initialDelay * 1000,
      maxDelayMs: config.llm.retry.maxDelay * 1000,
      exponentialBase: config.llm.retry.exponentialBase,
    },
    toolHooks: [createToolGovernanceExecutionHook(config, options, { sessionManager, sessionId })],
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
