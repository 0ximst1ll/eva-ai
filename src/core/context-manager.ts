import type { Message } from '../schema.js';
import type { ContextBuildSummary, ContextBuilder } from './context-builder.js';
import type { ProjectContextResource } from './resource-loader.js';
import type { SessionCompactionInfo, SessionManager, SessionUsageInfo } from './session-manager.js';
import { estimateMessagesTokens, type TokenEstimate } from './token-estimator.js';

export interface ContextDiagnosticsInput {
  sessionId: string;
  messages: Message[];
  maxSteps?: number | null;
}

export interface ContextStepGuardDiagnostics {
  enabled: boolean;
  maxSteps?: number;
}

export interface ProjectContextDiagnostics {
  count: number;
  resources: ProjectContextResource[];
  budgetChars: number;
}

export interface ContextUsageDiagnostics {
  estimatedTokens: number;
  contextWindowTokens: number | null;
  percent: number | null;
  source: 'latest_request' | 'active_messages';
  method: TokenEstimate['method'];
}

export interface ContextDiagnostics {
  activeMessageCount: number;
  activeMessageTokenEstimate: TokenEstimate;
  contextUsage: ContextUsageDiagnostics;
  stepGuard: ContextStepGuardDiagnostics;
  compaction: SessionCompactionInfo;
  usage: SessionUsageInfo;
  projectContext: ProjectContextDiagnostics;
  latestBuild: ContextBuildSummary | null;
}

export interface ContextManager {
  readonly contextBuilder: ContextBuilder;
  setContextBuilder(contextBuilder: ContextBuilder): void;
  getDiagnostics(input: ContextDiagnosticsInput): ContextDiagnostics;
}

export function createContextManager({
  contextBuilder,
  sessionManager,
  contextWindowTokens,
}: {
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
  contextWindowTokens?: number | null;
}): ContextManager {
  let currentContextBuilder = contextBuilder;
  const normalizedContextWindowTokens = normalizeOptionalPositiveInteger(contextWindowTokens);

  return {
    get contextBuilder() {
      return currentContextBuilder;
    },
    setContextBuilder(nextContextBuilder: ContextBuilder): void {
      currentContextBuilder = nextContextBuilder;
    },
    getDiagnostics({ sessionId, messages, maxSteps }: ContextDiagnosticsInput): ContextDiagnostics {
      const stepGuard = typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
        ? { enabled: true, maxSteps }
        : { enabled: false };
      const activeMessageTokenEstimate = estimateMessagesTokens(messages);
      const latestBuild = currentContextBuilder.latestBuild;

      return {
        activeMessageCount: messages.length,
        activeMessageTokenEstimate,
        contextUsage: createContextUsageDiagnostics({
          tokenEstimate: latestBuild?.requestTokenEstimate ?? activeMessageTokenEstimate,
          contextWindowTokens: normalizedContextWindowTokens,
          source: latestBuild ? 'latest_request' : 'active_messages',
        }),
        stepGuard,
        compaction: sessionManager.getCompactionInfo(sessionId),
        usage: sessionManager.getUsageInfo(sessionId),
        projectContext: {
          count: currentContextBuilder.projectContext.length,
          resources: currentContextBuilder.projectContext,
          budgetChars: currentContextBuilder.projectContextMaxChars,
        },
        latestBuild,
      };
    },
  };
}

function normalizeOptionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function createContextUsageDiagnostics({
  tokenEstimate,
  contextWindowTokens,
  source,
}: {
  tokenEstimate: TokenEstimate;
  contextWindowTokens: number | null;
  source: ContextUsageDiagnostics['source'];
}): ContextUsageDiagnostics {
  return {
    estimatedTokens: tokenEstimate.tokens,
    contextWindowTokens,
    percent: contextWindowTokens ? (tokenEstimate.tokens / contextWindowTokens) * 100 : null,
    source,
    method: tokenEstimate.method,
  };
}
