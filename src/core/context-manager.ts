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

export interface ContextDiagnostics {
  activeMessageCount: number;
  activeMessageTokenEstimate: TokenEstimate;
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
}: {
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
}): ContextManager {
  let currentContextBuilder = contextBuilder;

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

      return {
        activeMessageCount: messages.length,
        activeMessageTokenEstimate: estimateMessagesTokens(messages),
        stepGuard,
        compaction: sessionManager.getCompactionInfo(sessionId),
        usage: sessionManager.getUsageInfo(sessionId),
        projectContext: {
          count: currentContextBuilder.projectContext.length,
          resources: currentContextBuilder.projectContext,
          budgetChars: currentContextBuilder.projectContextMaxChars,
        },
        latestBuild: currentContextBuilder.latestBuild,
      };
    },
  };
}
