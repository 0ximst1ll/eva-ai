import type { AgentMessage } from '../schema.js';
import { defaultConvertToLlm } from './agent-messages.js';
import type { ContextBuildSummary, ContextBuilder } from './context-builder.js';
import type { ProjectContextResource } from './resource-loader.js';
import type { SessionCompactionInfo, SessionManager, SessionUsageInfo } from './session-manager.js';
import { type TokenCounter, type TokenCountMethod, type TokenCountSource, countMessagesLocally } from './token-counter.js';
import { estimateMessagesTokens, type TokenEstimate } from './token-estimator.js';

export interface ContextDiagnosticsInput {
  sessionId: string;
  messages: AgentMessage[];
  maxSteps?: number | null;
  usageSource?: 'auto' | 'active_messages';
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
  source: 'latest_provider_request_view' | 'active_messages';
  countSource: TokenCountSource;
  method: TokenCountMethod;
}

export type CompactionRecommendationReason =
  | 'auto_disabled'
  | 'context_window_unknown'
  | 'below_reserve'
  | 'reserve_reached';

export interface CompactionOptions {
  enabled: boolean;
  reserveTokens: number;
}

export interface CompactionRecommendationDiagnostics {
  shouldCompact: boolean;
  reason: CompactionRecommendationReason;
  autoEnabled: boolean;
  reserveTokens: number;
  estimatedTokens: number;
  contextWindowTokens: number | null;
  usagePercent: number | null;
}

export interface ContextDiagnostics {
  activeMessageCount: number;
  activeMessageTokenEstimate: TokenEstimate;
  contextUsage: ContextUsageDiagnostics;
  compactionRecommendation: CompactionRecommendationDiagnostics;
  stepGuard: ContextStepGuardDiagnostics;
  compaction: SessionCompactionInfo;
  usage: SessionUsageInfo;
  projectContext: ProjectContextDiagnostics;
  latestBuild: ContextBuildSummary | null;
}

export interface ContextManager {
  readonly contextBuilder: ContextBuilder;
  setContextBuilder(contextBuilder: ContextBuilder): void;
  getDiagnostics(input: ContextDiagnosticsInput): Promise<ContextDiagnostics>;
}

export function createContextManager({
  contextBuilder,
  sessionManager,
  contextWindowTokens,
  tokenCounter,
  compaction,
}: {
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
  contextWindowTokens?: number | null;
  tokenCounter?: TokenCounter;
  compaction?: Partial<CompactionOptions>;
}): ContextManager {
  let currentContextBuilder = contextBuilder;
  const normalizedContextWindowTokens = normalizeOptionalPositiveInteger(contextWindowTokens);
  const normalizedCompaction = normalizeCompactionOptions(compaction);

  return {
    get contextBuilder() {
      return currentContextBuilder;
    },
    setContextBuilder(nextContextBuilder: ContextBuilder): void {
      currentContextBuilder = nextContextBuilder;
    },
    async getDiagnostics({
      sessionId,
      messages,
      maxSteps,
      usageSource = 'auto',
    }: ContextDiagnosticsInput): Promise<ContextDiagnostics> {
      const stepGuard = typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
        ? { enabled: true, maxSteps }
        : { enabled: false };
      const activeLlmMessages = defaultConvertToLlm(messages);
      const activeMessageTokenEstimate = estimateMessagesTokens(activeLlmMessages);
      const latestBuild = currentContextBuilder.latestBuild;
      const latestProviderRequestView = usageSource === 'auto' ? currentContextBuilder.latestProviderRequestView : null;
      const contextUsageMessages = latestProviderRequestView?.messages ?? activeLlmMessages;
      const contextTokenCount = tokenCounter
        ? await tokenCounter.countMessages({ messages: contextUsageMessages })
        : countMessagesLocally(contextUsageMessages);
      const contextUsage = createContextUsageDiagnostics({
        tokenCount: contextTokenCount,
        contextWindowTokens: normalizedContextWindowTokens,
        source: latestProviderRequestView ? 'latest_provider_request_view' : 'active_messages',
      });

      return {
        activeMessageCount: messages.length,
        activeMessageTokenEstimate,
        contextUsage,
        compactionRecommendation: createCompactionRecommendation({
          contextUsage,
          compaction: normalizedCompaction,
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
  tokenCount,
  contextWindowTokens,
  source,
}: {
  tokenCount: ReturnType<typeof countMessagesLocally>;
  contextWindowTokens: number | null;
  source: ContextUsageDiagnostics['source'];
}): ContextUsageDiagnostics {
  return {
    estimatedTokens: tokenCount.tokens,
    contextWindowTokens,
    percent: contextWindowTokens ? (tokenCount.tokens / contextWindowTokens) * 100 : null,
    source,
    countSource: tokenCount.source,
    method: tokenCount.method,
  };
}

function normalizeCompactionOptions(options: Partial<CompactionOptions> | undefined): CompactionOptions {
  return {
    enabled: options?.enabled ?? false,
    reserveTokens: normalizePositiveInteger(options?.reserveTokens, 16384),
  };
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function createCompactionRecommendation({
  contextUsage,
  compaction,
}: {
  contextUsage: ContextUsageDiagnostics;
  compaction: CompactionOptions;
}): CompactionRecommendationDiagnostics {
  const base = {
    autoEnabled: compaction.enabled,
    reserveTokens: compaction.reserveTokens,
    estimatedTokens: contextUsage.estimatedTokens,
    contextWindowTokens: contextUsage.contextWindowTokens,
    usagePercent: contextUsage.percent,
  };

  if (!compaction.enabled) {
    return {
      ...base,
      shouldCompact: false,
      reason: 'auto_disabled',
    };
  }

  if (!contextUsage.contextWindowTokens || contextUsage.percent === null) {
    return {
      ...base,
      shouldCompact: false,
      reason: 'context_window_unknown',
    };
  }

  if (contextUsage.estimatedTokens >= contextUsage.contextWindowTokens - compaction.reserveTokens) {
    return {
      ...base,
      shouldCompact: true,
      reason: 'reserve_reached',
    };
  }

  return {
    ...base,
    shouldCompact: false,
    reason: 'below_reserve',
  };
}
