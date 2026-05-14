import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { LlmMessage } from '../schema.js';
import { isCompactionSummaryMessage } from './compaction.js';
import type { ProjectContextResource } from './resource-loader.js';
import { estimateMessagesTokens, estimateTextTokens, type TokenEstimate } from './token-estimator.js';

export const DEFAULT_PROJECT_CONTEXT_MAX_CHARS = 20000;
export const DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS = 4000;

export interface ContextBuilder {
  readonly projectContext: ProjectContextResource[];
  readonly projectContextMaxChars: number;
  readonly latestBuild: ContextBuildSummary | null;
  readonly latestProviderRequestView: ProviderRequestView | null;
  /** @deprecated Use latestProviderRequestView.messages. */
  readonly latestRequestMessages: LlmMessage[] | null;
  build(input: BuildProviderRequestViewInput): ProviderRequestView;
}

export interface BuildProviderRequestViewInput {
  systemPrompt: string;
  llmMessages: LlmMessage[];
}

export interface ProviderRequestView {
  messages: LlmMessage[];
  diagnostics: RuntimeDiagnostic[];
  summary: ContextBuildSummary;
}

/** @deprecated Use BuildProviderRequestViewInput. */
export type BuildContextInput = BuildProviderRequestViewInput;

/** @deprecated Use ProviderRequestView. */
export type BuildContextResult = ProviderRequestView;

export interface ContextBuildSummary {
  injected: boolean;
  compactedContext: boolean;
  projectContextBudgetMode: 'normal' | 'post_compact';
  projectContextCount: number;
  projectContextNames: string[];
  projectContextContentLength: number;
  projectContextOriginalContentLength: number;
  projectContextMaxChars: number;
  projectContextConfiguredMaxChars: number;
  projectContextTruncated: boolean;
  projectContextSkippedReason?: string;
  inputLlmMessageCount: number;
  providerRequestMessageCount: number;
  /** @deprecated Use inputLlmMessageCount. */
  inputMessageCount: number;
  /** @deprecated Use providerRequestMessageCount. */
  requestMessageCount: number;
  builtAt: number;
  providerRequestTokenEstimate: TokenEstimate;
  /** @deprecated Use providerRequestTokenEstimate. */
  requestTokenEstimate: TokenEstimate;
  projectContextTokenEstimate: TokenEstimate;
}

function isCompactedContext(messages: LlmMessage[]): boolean {
  return messages.some(isCompactionSummaryMessage);
}

export interface CreateContextBuilderOptions {
  projectContext?: ProjectContextResource[];
  projectContextMaxChars?: number;
}

interface FormattedProjectContext {
  content: string | null;
  originalContentLength: number;
  contentLength: number;
  truncated: boolean;
  skippedReason?: string;
}

function normalizeBudget(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return DEFAULT_PROJECT_CONTEXT_MAX_CHARS;
  return Math.max(0, Math.floor(maxChars));
}

function formatProjectContext(resources: ProjectContextResource[], maxChars: number): FormattedProjectContext {
  const blocks = resources
    .filter((resource) => resource.content.trim().length > 0)
    .map((resource) => [
      `Contents of ${resource.name}:`,
      '',
      resource.content.trim(),
    ].join('\n'));

  if (blocks.length === 0) {
    return {
      content: null,
      originalContentLength: 0,
      contentLength: 0,
      truncated: false,
      skippedReason: 'empty',
    };
  }

  const prefix = '<project_context>\n\n';
  const suffix = '\n\n</project_context>';
  const body = blocks.join('\n\n');
  const fullContent = `${prefix}${body}${suffix}`;
  if (fullContent.length <= maxChars) {
    return {
      content: fullContent,
      originalContentLength: fullContent.length,
      contentLength: fullContent.length,
      truncated: false,
    };
  }

  const truncationNotice = '\n\n[Project context truncated to fit budget]';
  const truncatedSuffix = `${truncationNotice}${suffix}`;
  const availableBodyChars = maxChars - prefix.length - truncatedSuffix.length;
  if (availableBodyChars <= 0) {
    return {
      content: null,
      originalContentLength: fullContent.length,
      contentLength: 0,
      truncated: false,
      skippedReason: 'budget_exhausted',
    };
  }

  const content = `${prefix}${body.slice(0, availableBodyChars)}${truncatedSuffix}`;
  return {
    content,
    originalContentLength: fullContent.length,
    contentLength: content.length,
    truncated: true,
  };
}

function withSystemMessage(messages: LlmMessage[], systemPrompt: string): LlmMessage[] {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return [{ role: 'system', content: systemPrompt }, ...rest];
  return [{ role: 'system', content: systemPrompt }, ...messages];
}

function insertAfterSystemMessage(
  messages: LlmMessage[],
  projectContextMessage: LlmMessage,
  systemPrompt: string,
): LlmMessage[] {
  const [first, ...rest] = withSystemMessage(messages, systemPrompt);
  return [first, projectContextMessage, ...rest];
}

export function createContextBuilder({
  projectContext = [],
  projectContextMaxChars,
}: CreateContextBuilderOptions = {}): ContextBuilder {
  const resources = projectContext.slice();
  const maxChars = normalizeBudget(projectContextMaxChars);
  let latestBuild: ContextBuildSummary | null = null;
  let latestProviderRequestView: ProviderRequestView | null = null;

  function createSummary({
    injected,
    compactedContext,
    budgetMode,
    formattedProjectContext,
    llmMessages,
    providerRequestMessages,
    projectContextNames,
    projectContextSkippedReason,
  }: {
    injected: boolean;
    compactedContext: boolean;
    budgetMode: ContextBuildSummary['projectContextBudgetMode'];
    formattedProjectContext: FormattedProjectContext;
    llmMessages: LlmMessage[];
    providerRequestMessages: LlmMessage[];
    projectContextNames: string[];
    projectContextSkippedReason?: string;
  }): ContextBuildSummary {
    const providerRequestTokenEstimate = estimateMessagesTokens(providerRequestMessages);
    return {
      injected,
      compactedContext,
      projectContextBudgetMode: budgetMode,
      projectContextCount: injected ? resources.length : 0,
      projectContextNames,
      projectContextContentLength: injected ? formattedProjectContext.contentLength : 0,
      projectContextOriginalContentLength: formattedProjectContext.originalContentLength,
      projectContextMaxChars: compactedContext
        ? Math.min(maxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS)
        : maxChars,
      projectContextConfiguredMaxChars: maxChars,
      projectContextTruncated: injected ? formattedProjectContext.truncated : false,
      projectContextSkippedReason,
      inputLlmMessageCount: llmMessages.length,
      providerRequestMessageCount: providerRequestMessages.length,
      inputMessageCount: llmMessages.length,
      requestMessageCount: providerRequestMessages.length,
      builtAt: Date.now(),
      providerRequestTokenEstimate,
      requestTokenEstimate: providerRequestTokenEstimate,
      projectContextTokenEstimate: estimateTextTokens(formattedProjectContext.content ?? ''),
    };
  }

  return {
    get latestBuild() {
      return latestBuild;
    },
    get latestProviderRequestView() {
      return latestProviderRequestView
        ? {
          messages: latestProviderRequestView.messages.slice(),
          diagnostics: latestProviderRequestView.diagnostics.slice(),
          summary: latestProviderRequestView.summary,
        }
        : null;
    },
    get latestRequestMessages() {
      return latestProviderRequestView?.messages.slice() ?? null;
    },
    projectContext: resources,
    projectContextMaxChars: maxChars,
    build({ systemPrompt, llmMessages }: BuildProviderRequestViewInput): ProviderRequestView {
      const compactedContext = isCompactedContext(llmMessages);
      const effectiveMaxChars = compactedContext
        ? Math.min(maxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS)
        : maxChars;
      const budgetMode: ContextBuildSummary['projectContextBudgetMode'] = compactedContext
        ? 'post_compact'
        : 'normal';
      const formattedProjectContext = formatProjectContext(resources, effectiveMaxChars);
      if (!formattedProjectContext.content) {
        const providerRequestMessages = withSystemMessage(llmMessages, systemPrompt);
        latestBuild = createSummary({
          injected: false,
          compactedContext,
          budgetMode,
          formattedProjectContext,
          llmMessages,
          providerRequestMessages,
          projectContextNames: [],
          projectContextSkippedReason: formattedProjectContext.skippedReason,
        });
        latestProviderRequestView = {
          messages: providerRequestMessages,
          diagnostics: [createDiagnostic({
            source: 'context',
            level: 'info',
            code: formattedProjectContext.skippedReason === 'budget_exhausted'
              ? 'project_context_skipped_budget'
              : 'project_context_empty',
            message: formattedProjectContext.skippedReason === 'budget_exhausted'
              ? `Project context skipped because budget is too small (${maxChars} chars)`
              : 'No project context injected',
            details: {
              budgetChars: effectiveMaxChars,
              configuredBudgetChars: maxChars,
              budgetMode,
              compactedContext,
              originalContentLength: formattedProjectContext.originalContentLength,
              skippedReason: formattedProjectContext.skippedReason,
            },
          })],
          summary: latestBuild,
        };
        return latestProviderRequestView;
      }

      const providerRequestMessages = insertAfterSystemMessage(
        llmMessages,
        { role: 'user', content: formattedProjectContext.content },
        systemPrompt,
      );
      latestBuild = createSummary({
        injected: true,
        compactedContext,
        budgetMode,
        formattedProjectContext,
        llmMessages,
        providerRequestMessages,
        projectContextNames: resources.map((resource) => resource.name),
      });

      latestProviderRequestView = {
        messages: providerRequestMessages,
        diagnostics: [createDiagnostic({
          source: 'context',
          level: 'info',
          code: formattedProjectContext.truncated ? 'project_context_truncated' : 'project_context_injected',
          message: formattedProjectContext.truncated
            ? `Injected ${resources.length} project context resource(s), truncated to ${formattedProjectContext.contentLength} chars`
            : `Injected ${resources.length} project context resource(s)`,
          details: {
            count: resources.length,
            names: resources.map((resource) => resource.name),
            budgetChars: effectiveMaxChars,
            configuredBudgetChars: maxChars,
            budgetMode,
            compactedContext,
            contentLength: formattedProjectContext.contentLength,
            originalContentLength: formattedProjectContext.originalContentLength,
            truncated: formattedProjectContext.truncated,
          },
        })],
        summary: latestBuild,
      };
      return latestProviderRequestView;
    },
  };
}
