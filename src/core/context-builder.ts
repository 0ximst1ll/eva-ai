import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { LlmMessage } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { isCompactionSummaryMessage } from './compaction.js';
import type { ProjectContextResource, SkillResource } from './resource-loader.js';
import { estimateMessagesTokens, estimateTextTokens, type TokenEstimate } from './token-estimator.js';

export const DEFAULT_PROJECT_CONTEXT_MAX_CHARS = 20000;
export const DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS = 4000;

export interface ContextBuilder {
  readonly projectContext: ProjectContextResource[];
  readonly skills: SkillResource[];
  readonly tools: Tool[];
  readonly projectContextMaxChars: number;
  readonly latestBuild: ContextBuildSummary | null;
  readonly latestProviderRequestView: ProviderRequestView | null;
  /** @deprecated Use latestProviderRequestView.messages. */
  readonly latestRequestMessages: LlmMessage[] | null;
  queueSkillInvocation(skillName: string): SkillInvocationResult;
  build(input: BuildProviderRequestViewInput): ProviderRequestView;
}

export type SkillInvocationResult =
  | { ok: true; skill: SkillResource; pendingCount: number }
  | { ok: false; reason: 'not_found'; skillName: string; availableSkills: string[] };

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
  skillsMetadataInjected: boolean;
  skillCount: number;
  skillNames: string[];
  toolPromptMetadataInjected: boolean;
  toolCount: number;
  toolNames: string[];
  skillInvocationInjected: boolean;
  skillInvocationCount: number;
  invokedSkillNames: string[];
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
  skills?: SkillResource[];
  tools?: Tool[];
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getModelVisibleSkills(skills: SkillResource[]): SkillResource[] {
  return skills.filter((skill) => !skill.disableModelInvocation);
}

function formatSkillsForSystemPrompt(skills: SkillResource[]): string | null {
  const visibleSkills = getModelVisibleSkills(skills);
  if (visibleSkills.length === 0) return null;

  const blocks = visibleSkills.map((skill) => [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.path)}">`,
    escapeXml(skill.description),
    '</skill>',
  ].join('\n'));

  return [
    '<available_skills>',
    ...blocks,
    '</available_skills>',
  ].join('\n');
}

function appendSkillsMetadata(systemPrompt: string, skills: SkillResource[]): string {
  const formattedSkills = formatSkillsForSystemPrompt(skills);
  if (!formattedSkills) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${formattedSkills}`;
}

function getRequiredParameters(tool: Tool): string[] {
  const required = tool.parameters['required'];
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

function formatToolForSystemPrompt(tool: Tool): string | null {
  const snippet = tool.promptSnippet?.trim() || tool.description.trim();
  if (!snippet) return null;

  const lines = [
    `<tool name="${escapeXml(tool.name)}">`,
    escapeXml(snippet),
  ];
  const required = getRequiredParameters(tool);
  if (required.length > 0) {
    lines.push(`Required arguments: ${required.map(escapeXml).join(', ')}`);
  }

  const guidelines = [...new Set((tool.promptGuidelines ?? [])
    .map((guideline) => guideline.trim())
    .filter(Boolean))];
  if (guidelines.length > 0) {
    lines.push('Guidelines:');
    for (const guideline of guidelines) {
      lines.push(`- ${escapeXml(guideline)}`);
    }
  }

  lines.push('</tool>');
  return lines.join('\n');
}

function formatToolsForSystemPrompt(tools: Tool[]): string | null {
  const blocks = tools
    .map(formatToolForSystemPrompt)
    .filter((block): block is string => Boolean(block));
  if (blocks.length === 0) return null;

  return [
    '<available_tools>',
    ...blocks,
    '</available_tools>',
  ].join('\n');
}

function appendToolMetadata(systemPrompt: string, tools: Tool[]): string {
  const formattedTools = formatToolsForSystemPrompt(tools);
  if (!formattedTools) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${formattedTools}`;
}

function formatSkillInvocations(skills: SkillResource[]): string | null {
  if (skills.length === 0) return null;

  const blocks = skills.map((skill) => [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.path)}">`,
    `References are relative to ${escapeXml(skill.baseDir)}.`,
    '',
    skill.content.trim(),
    '</skill>',
  ].join('\n'));

  return [
    '<invoked_skills>',
    ...blocks,
    '</invoked_skills>',
  ].join('\n');
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
  skills = [],
  tools = [],
  projectContextMaxChars,
}: CreateContextBuilderOptions = {}): ContextBuilder {
  const resources = projectContext.slice();
  const skillResources = skills.slice();
  const activeTools = tools.slice();
  let pendingSkillInvocations: SkillResource[] = [];
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
    invokedSkills,
  }: {
    injected: boolean;
    compactedContext: boolean;
    budgetMode: ContextBuildSummary['projectContextBudgetMode'];
    formattedProjectContext: FormattedProjectContext;
    llmMessages: LlmMessage[];
    providerRequestMessages: LlmMessage[];
    projectContextNames: string[];
    projectContextSkippedReason?: string;
    invokedSkills: SkillResource[];
  }): ContextBuildSummary {
    const providerRequestTokenEstimate = estimateMessagesTokens(providerRequestMessages);
    const visibleSkills = getModelVisibleSkills(skillResources);
    const promptTools = activeTools.filter((tool) => tool.promptSnippet?.trim() || tool.description.trim());
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
      skillsMetadataInjected: visibleSkills.length > 0,
      skillCount: visibleSkills.length,
      skillNames: visibleSkills.map((skill) => skill.name),
      toolPromptMetadataInjected: promptTools.length > 0,
      toolCount: promptTools.length,
      toolNames: promptTools.map((tool) => tool.name),
      skillInvocationInjected: invokedSkills.length > 0,
      skillInvocationCount: invokedSkills.length,
      invokedSkillNames: invokedSkills.map((skill) => skill.name),
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
    skills: skillResources,
    tools: activeTools,
    projectContextMaxChars: maxChars,
    queueSkillInvocation(skillName: string): SkillInvocationResult {
      const normalizedName = skillName.trim();
      const skill = skillResources.find((candidate) => candidate.name === normalizedName);
      if (!skill) {
        return {
          ok: false,
          reason: 'not_found',
          skillName: normalizedName,
          availableSkills: skillResources.map((candidate) => candidate.name),
        };
      }

      pendingSkillInvocations.push(skill);
      return { ok: true, skill, pendingCount: pendingSkillInvocations.length };
    },
    build({ systemPrompt, llmMessages }: BuildProviderRequestViewInput): ProviderRequestView {
      const invokedSkills = pendingSkillInvocations;
      pendingSkillInvocations = [];
      const systemPromptWithTools = appendToolMetadata(systemPrompt, activeTools);
      const systemPromptWithSkills = appendSkillsMetadata(systemPromptWithTools, skillResources);
      const compactedContext = isCompactedContext(llmMessages);
      const effectiveMaxChars = compactedContext
        ? Math.min(maxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS)
        : maxChars;
      const budgetMode: ContextBuildSummary['projectContextBudgetMode'] = compactedContext
        ? 'post_compact'
        : 'normal';
      const formattedProjectContext = formatProjectContext(resources, effectiveMaxChars);
      const formattedSkillInvocations = formatSkillInvocations(invokedSkills);
      const skillInvocationMessage = formattedSkillInvocations
        ? { role: 'user', content: formattedSkillInvocations } satisfies LlmMessage
        : null;
      if (!formattedProjectContext.content) {
        const providerRequestMessages = skillInvocationMessage
          ? insertAfterSystemMessage(llmMessages, skillInvocationMessage, systemPromptWithSkills)
          : withSystemMessage(llmMessages, systemPromptWithSkills);
        latestBuild = createSummary({
          injected: false,
          compactedContext,
          budgetMode,
          formattedProjectContext,
          llmMessages,
          providerRequestMessages,
          projectContextNames: [],
          projectContextSkippedReason: formattedProjectContext.skippedReason,
          invokedSkills,
        });
        const diagnostics = [createDiagnostic({
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
        })];
        if (invokedSkills.length > 0) {
          diagnostics.push(createDiagnostic({
            source: 'context',
            level: 'info',
            code: 'skills_invoked',
            message: `Injected ${invokedSkills.length} invoked skill(s)`,
            details: {
              skills: invokedSkills.map((skill) => ({ name: skill.name, path: skill.path })),
            },
          }));
        }
        latestProviderRequestView = {
          messages: providerRequestMessages,
          diagnostics,
          summary: latestBuild,
        };
        return latestProviderRequestView;
      }

      let providerRequestMessages = insertAfterSystemMessage(
        llmMessages,
        { role: 'user', content: formattedProjectContext.content },
        systemPromptWithSkills,
      );
      if (skillInvocationMessage) {
        const [systemMessage, projectContextMessage, ...rest] = providerRequestMessages;
        providerRequestMessages = [systemMessage, projectContextMessage, skillInvocationMessage, ...rest];
      }
      latestBuild = createSummary({
        injected: true,
        compactedContext,
        budgetMode,
        formattedProjectContext,
        llmMessages,
        providerRequestMessages,
        projectContextNames: resources.map((resource) => resource.name),
        invokedSkills,
      });
      const diagnostics = [createDiagnostic({
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
      })];
      if (invokedSkills.length > 0) {
        diagnostics.push(createDiagnostic({
          source: 'context',
          level: 'info',
          code: 'skills_invoked',
          message: `Injected ${invokedSkills.length} invoked skill(s)`,
          details: {
            skills: invokedSkills.map((skill) => ({ name: skill.name, path: skill.path })),
          },
        }));
      }

      latestProviderRequestView = {
        messages: providerRequestMessages,
        diagnostics,
        summary: latestBuild,
      };
      return latestProviderRequestView;
    },
  };
}
