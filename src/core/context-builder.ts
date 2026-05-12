import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { Message } from '../schema.js';
import { isCompactionSummaryMessage } from './compaction.js';
import type { ProjectContextResource } from './resource-loader.js';
import { estimateMessagesTokens, estimateTextTokens, type TokenEstimate } from './token-estimator.js';

export const DEFAULT_PROJECT_CONTEXT_MAX_CHARS = 20000;
export const DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS = 4000;

export interface ContextBuilder {
  readonly projectContext: ProjectContextResource[];
  readonly projectContextMaxChars: number;
  readonly latestBuild: ContextBuildSummary | null;
  readonly latestRequestMessages: Message[] | null;
  build(input: BuildContextInput): BuildContextResult;
}

export interface BuildContextInput {
  systemPrompt: string;
  messages: Message[];
}

export interface BuildContextResult {
  messages: Message[];
  diagnostics: RuntimeDiagnostic[];
  summary: ContextBuildSummary;
}

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
  inputMessageCount: number;
  requestMessageCount: number;
  builtAt: number;
  requestTokenEstimate: TokenEstimate;
  projectContextTokenEstimate: TokenEstimate;
}

function isCompactedContext(messages: Message[]): boolean {
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

function withSystemMessage(messages: Message[], systemPrompt: string): Message[] {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return [{ role: 'system', content: systemPrompt }, ...rest];
  return [{ role: 'system', content: systemPrompt }, ...messages];
}

function insertAfterSystemMessage(messages: Message[], projectContextMessage: Message, systemPrompt: string): Message[] {
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
  let latestRequestMessages: Message[] | null = null;

  return {
    get latestBuild() {
      return latestBuild;
    },
    get latestRequestMessages() {
      return latestRequestMessages?.slice() ?? null;
    },
    projectContext: resources,
    projectContextMaxChars: maxChars,
    build({ systemPrompt, messages }: BuildContextInput): BuildContextResult {
      const compactedContext = isCompactedContext(messages);
      const effectiveMaxChars = compactedContext
        ? Math.min(maxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS)
        : maxChars;
      const budgetMode: ContextBuildSummary['projectContextBudgetMode'] = compactedContext
        ? 'post_compact'
        : 'normal';
      const formattedProjectContext = formatProjectContext(resources, effectiveMaxChars);
      if (!formattedProjectContext.content) {
        const requestMessages = withSystemMessage(messages, systemPrompt);
        latestRequestMessages = requestMessages.slice();
        latestBuild = {
          injected: false,
          compactedContext,
          projectContextBudgetMode: budgetMode,
          projectContextCount: 0,
          projectContextNames: [],
          projectContextContentLength: 0,
          projectContextOriginalContentLength: formattedProjectContext.originalContentLength,
          projectContextMaxChars: effectiveMaxChars,
          projectContextConfiguredMaxChars: maxChars,
          projectContextTruncated: false,
          projectContextSkippedReason: formattedProjectContext.skippedReason,
          inputMessageCount: messages.length,
          requestMessageCount: requestMessages.length,
          builtAt: Date.now(),
          requestTokenEstimate: estimateMessagesTokens(requestMessages),
          projectContextTokenEstimate: estimateTextTokens(''),
        };
        return {
          messages: requestMessages,
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
      }

      const requestMessages = insertAfterSystemMessage(
        messages,
        { role: 'user', content: formattedProjectContext.content },
        systemPrompt,
      );
      latestRequestMessages = requestMessages.slice();
      latestBuild = {
        injected: true,
        compactedContext,
        projectContextBudgetMode: budgetMode,
        projectContextCount: resources.length,
        projectContextNames: resources.map((resource) => resource.name),
        projectContextContentLength: formattedProjectContext.contentLength,
        projectContextOriginalContentLength: formattedProjectContext.originalContentLength,
        projectContextMaxChars: effectiveMaxChars,
        projectContextConfiguredMaxChars: maxChars,
        projectContextTruncated: formattedProjectContext.truncated,
        inputMessageCount: messages.length,
        requestMessageCount: requestMessages.length,
        builtAt: Date.now(),
        requestTokenEstimate: estimateMessagesTokens(requestMessages),
        projectContextTokenEstimate: estimateTextTokens(formattedProjectContext.content),
      };

      return {
        messages: requestMessages,
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
    },
  };
}
