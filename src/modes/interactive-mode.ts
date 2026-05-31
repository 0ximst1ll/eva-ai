import * as readline from 'node:readline';
import {
  RuntimeSessionNotFoundError,
  type RuntimeDiagnostic,
  type ToolConfirmationRequest,
  type ToolPermissionDecision,
} from '../core/runtime.js';
import type { ContextBuildSummary } from '../core/context-builder.js';
import type { ContextDiagnostics } from '../core/context-manager.js';
import type {
  SessionBranchSummary,
  SessionListItem,
  SessionEntryTreeViewNode,
  SessionPathEntry,
  SessionTreeNode,
} from '../core/session-manager.js';
import {
  RuntimeChildSessionAmbiguousError,
  RuntimeChildSessionNotFoundError,
  type RuntimeHost,
} from '../core/runtime-host.js';
import { Colors } from '../utils/terminal.js';
import { createCliRenderer, createToolConfirmationPrompt, formatRuntimeDiagnostic } from './cli-ui.js';

export interface InteractiveModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) => void;
}

export type InteractiveCommandResult = 'not_command' | 'continue' | 'exit';

async function getContextDiagnostics(host: RuntimeHost): Promise<ContextDiagnostics | undefined> {
  return host.runtime.services?.contextManager?.getDiagnostics({
    sessionId: host.sessionId,
    messages: host.session.messages,
    maxSteps: host.session.maxSteps,
  });
}

function formatContextBuildStatus(latestBuild: ContextBuildSummary | null): string {
  if (!latestBuild) return 'not built yet';
  const budget = latestBuild.projectContextBudgetMode === 'post_compact'
    ? `budget=${latestBuild.projectContextMaxChars} (post_compact, configured=${latestBuild.projectContextConfiguredMaxChars})`
    : `budget=${latestBuild.projectContextMaxChars}`;
  if (!latestBuild.injected) {
    const reason = latestBuild.projectContextSkippedReason
      ? `, reason=${latestBuild.projectContextSkippedReason}`
      : '';
    const invokedSkills = latestBuild.skillInvocationInjected
      ? `, invoked_skills=${latestBuild.invokedSkillNames.join(',')}`
      : '';
    return `not injected${reason}, provider request messages=${latestBuild.providerRequestMessageCount}, estimated provider request tokens=${latestBuild.providerRequestTokenEstimate.tokens}, ${budget}${invokedSkills}`;
  }
  const status = [
    `injected ${latestBuild.projectContextCount} resource(s)`,
    `provider request messages=${latestBuild.providerRequestMessageCount}`,
    `estimated provider request tokens=${latestBuild.providerRequestTokenEstimate.tokens}`,
    `chars=${latestBuild.projectContextContentLength}/${latestBuild.projectContextMaxChars}`,
  ];
  if (latestBuild.projectContextBudgetMode === 'post_compact') {
    status.push(`budget=post_compact configured=${latestBuild.projectContextConfiguredMaxChars}`);
  }
  if (latestBuild.skillInvocationInjected) {
    status.push(`invoked_skills=${latestBuild.invokedSkillNames.join(',')}`);
  }
  if (latestBuild.projectContextTruncated) status.push('truncated');
  return status.join(', ');
}

function formatStepGuard(stepGuard: ContextDiagnostics['stepGuard']): string {
  return stepGuard.enabled ? `max_steps=${stepGuard.maxSteps}` : 'disabled';
}

function formatCompactionStatus(compaction: ContextDiagnostics['compaction']): string {
  if (!compaction.compacted) return 'none';
  return `compacted messages ${compaction.messagesBefore} -> ${compaction.messagesAfter}, summary chars=${compaction.summaryLength}`;
}

function formatUsageStatus(usage: ContextDiagnostics['usage']): string {
  if (!usage.count) return 'unknown';
  return [
    `calls=${usage.count}`,
    `prompt=${usage.total.prompt_tokens}`,
    `completion=${usage.total.completion_tokens}`,
    `total=${usage.total.total_tokens}`,
  ].join(', ');
}

function formatLatestUsageStatus(usage: ContextDiagnostics['usage']): string {
  if (!usage.latest) return 'unknown';
  const timestamp = usage.latestTimestamp ? new Date(usage.latestTimestamp).toISOString() : 'unknown';
  const source = usage.latestSource ?? 'unknown';
  return [
    `source=${source}`,
    `prompt=${usage.latest.prompt_tokens}`,
    `completion=${usage.latest.completion_tokens}`,
    `total=${usage.latest.total_tokens}`,
    `at=${timestamp}`,
  ].join(', ');
}

function formatTokenEstimateStatus(diagnostics: ContextDiagnostics): string {
  const latestBuild = diagnostics.latestBuild;
  const parts = [`active=${diagnostics.activeMessageTokenEstimate.tokens}`];
  if (latestBuild) {
    parts.push(`provider_request=${latestBuild.providerRequestTokenEstimate.tokens}`);
    parts.push(`project_context=${latestBuild.projectContextTokenEstimate.tokens}`);
  }
  parts.push(`method=${diagnostics.activeMessageTokenEstimate.method}`);
  return parts.join(', ');
}

function formatContextUsageStatus(diagnostics: ContextDiagnostics): string {
  const usage = diagnostics.contextUsage;
  const window = usage.contextWindowTokens?.toString() ?? 'unknown';
  const percent = usage.percent === null ? 'unknown' : `${usage.percent.toFixed(1)}%`;
  return [
    `estimated=${usage.estimatedTokens}`,
    `window=${window}`,
    `percent=${percent}`,
    `source=${usage.source}`,
    `count=${usage.countSource}`,
    `method=${usage.method}`,
  ].join(', ');
}

function formatCompactionRecommendationStatus(diagnostics: ContextDiagnostics): string {
  const recommendation = diagnostics.compactionRecommendation;
  const decision = recommendation.shouldCompact ? 'yes' : 'no';
  const usage = recommendation.usagePercent === null ? 'unknown' : `${recommendation.usagePercent.toFixed(1)}%`;
  const window = recommendation.contextWindowTokens?.toString() ?? 'unknown';
  return [
    decision,
    `reason=${recommendation.reason}`,
    `auto=${recommendation.autoEnabled ? 'enabled' : 'disabled'}`,
    `usage=${usage}`,
    `reserve=${recommendation.reserveTokens}`,
    `estimated=${recommendation.estimatedTokens}`,
    `window=${window}`,
  ].join(', ');
}

function formatPermissionDecisionStatus(
  permission: ContextDiagnostics['permissionPending'],
  fallbackReason: string,
): string {
  if (!permission.count) return 'none';
  const metadata = permission.latest?.metadata ?? {};
  const toolName = typeof metadata['toolName'] === 'string' ? metadata['toolName'] : 'unknown';
  const reason = permission.latest?.content ?? fallbackReason;
  return `count=${permission.count}, latest tool=${toolName}, reason=${reason}`;
}

function formatSkillsStatus(diagnostics: ContextDiagnostics): string {
  const skills = diagnostics.skills;
  const parts = [
    `loaded=${skills.count}`,
    `visible=${skills.visibleCount}`,
    `hidden=${skills.hiddenCount}`,
  ];
  if (skills.latestInvokedNames.length > 0) {
    parts.push(`last_invoked=${skills.latestInvokedNames.join(',')}`);
  }
  return parts.join(', ');
}

function writeContextDiagnostics(
  diagnostics: ContextDiagnostics,
  writeLine: (message?: string) => void,
): void {
  const compaction = diagnostics.compaction;
  writeLine(`${Colors.BRIGHT_CYAN}Context:${Colors.RESET}`);
  writeLine(`  Active messages: ${diagnostics.activeMessageCount}`);
  writeLine(`  Step guard: ${formatStepGuard(diagnostics.stepGuard)}`);
  writeLine(`  Compaction: ${formatCompactionStatus(compaction)}`);
  if (compaction.compacted) {
    writeLine(`  - First kept message index: ${compaction.firstKeptMessageIndex}`);
    writeLine(`  - Compacted at: ${compaction.timestamp ? new Date(compaction.timestamp).toISOString() : 'unknown'}`);
    writeLine(`  - Custom instructions: ${compaction.customInstructions ? 'yes' : 'no'}`);
  }
  writeLine(`  Token usage: ${formatUsageStatus(diagnostics.usage)}`);
  writeLine(`  Latest usage: ${formatLatestUsageStatus(diagnostics.usage)}`);
  writeLine(`  Context usage: ${formatContextUsageStatus(diagnostics)}`);
  writeLine(`  Compaction recommendation: ${formatCompactionRecommendationStatus(diagnostics)}`);
  writeLine(`  Permission pending: ${formatPermissionDecisionStatus(diagnostics.permissionPending, 'permission pending')}`);
  writeLine(`  Permission denied: ${formatPermissionDecisionStatus(diagnostics.permissionDenied, 'permission denied')}`);
  writeLine(`  Estimated tokens: ${formatTokenEstimateStatus(diagnostics)}`);
  writeLine(`  Project context resources: ${diagnostics.projectContext.count}`);
  for (const resource of diagnostics.projectContext.resources) {
    writeLine(`  - ${resource.name} path=${resource.path} chars=${resource.content.length}`);
  }
  writeLine(`  Budget: ${diagnostics.projectContext.budgetChars} chars`);
  writeLine(`  Skills: ${formatSkillsStatus(diagnostics)}`);
  for (const skill of diagnostics.skills.resources) {
    const visibility = skill.disableModelInvocation ? 'hidden' : 'visible';
    writeLine(
      `  - ${skill.name} ${visibility} source=${skill.sourceInfo.source} scope=${skill.sourceInfo.scope} path=${skill.path}`,
    );
  }
  writeLine(`  Last build: ${formatContextBuildStatus(diagnostics.latestBuild)}`);
}

function writeSessionTree({
  nodes,
  currentSessionId,
  writeLine,
  depth = 0,
}: {
  nodes: SessionTreeNode[];
  currentSessionId: string;
  writeLine: (message?: string) => void;
  depth?: number;
}): void {
  for (const node of nodes) {
    const session = node.session;
    const currentMarker = session.sessionId === currentSessionId ? '*' : ' ';
    const latestMarker = session.isLatest ? ' latest' : '';
    const updatedAt = session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : 'unknown';
    const indent = '  '.repeat(depth);
    const forkInfo = typeof session.forkedFromMessageIndex === 'number'
      ? ` forked_from=${session.forkedFromMessageIndex}`
      : '';
    writeLine(
      `${indent}${currentMarker} ${session.sessionId} messages=${session.messageCount} updated=${updatedAt}${latestMarker}${forkInfo}`,
    );
    writeSessionTree({
      nodes: node.children,
      currentSessionId,
      writeLine,
      depth: depth + 1,
    });
  }
}

function writeChildSessions({
  sessions,
  writeLine,
}: {
  sessions: SessionListItem[];
  writeLine: (message?: string) => void;
}): void {
  for (const session of sessions) {
    const latestMarker = session.isLatest ? ' latest' : '';
    const updatedAt = session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : 'unknown';
    const forkInfo = typeof session.forkedFromMessageIndex === 'number'
      ? ` forked_from=${session.forkedFromMessageIndex}`
      : '';
    writeLine(`  ${session.sessionId} messages=${session.messageCount} updated=${updatedAt}${latestMarker}${forkInfo}`);
  }
}

function writeEntryTree({
  nodes,
  writeLine,
  depth = 0,
}: {
  nodes: SessionEntryTreeViewNode[];
  writeLine: (message?: string) => void;
  depth?: number;
}): void {
  for (const node of nodes) {
    const entry = node.entry;
    const activeMarker = entry.isActive ? '*' : entry.isActivePath ? '+' : ' ';
    const indent = '  '.repeat(depth);
    const timestamp = entry.timestamp > 0 ? new Date(entry.timestamp).toISOString() : 'unknown';
    const activePath = entry.isActivePath ? ' active_path=true' : '';
    const role = entry.messageRole ? ` role=${entry.messageRole}` : '';
    const kind = entry.kind ? ` kind=${entry.kind}` : '';
    const messageIndex = typeof entry.messageIndex === 'number' ? ` message_index=${entry.messageIndex}` : '';
    const preview = entry.preview ? ` preview="${entry.preview}"` : '';
    writeLine(
      `${indent}${activeMarker} ${entry.entryId} type=${entry.type}${activePath}${role}${kind}${messageIndex} parent=${entry.parentEntryId ?? 'root'} updated=${timestamp}${preview}`,
    );
    writeEntryTree({ nodes: node.children, writeLine, depth: depth + 1 });
  }
}

function getPathEntryLabel(entry: SessionPathEntry, index: number): string {
  if (entry.type === 'message') {
    const content = typeof entry.message.content === 'string'
      ? entry.message.content
      : JSON.stringify(entry.message.content);
    const preview = content.length > 80 ? `${content.slice(0, 77)}...` : content;
    return `#${index} ${entry.entryId} type=message role=${entry.message.role} parent=${entry.parentEntryId ?? 'root'} preview="${preview}"`;
  }

  if (entry.type === 'internal') {
    const preview = entry.content ? ` preview="${entry.content.length > 80 ? `${entry.content.slice(0, 77)}...` : entry.content}"` : '';
    return `#${index} ${entry.entryId} type=internal kind=${entry.kind} parent=${entry.parentEntryId ?? 'root'}${preview}`;
  }

  if (entry.type === 'compaction') {
    return `#${index} ${entry.entryId} type=compaction parent=${entry.parentEntryId ?? 'root'} messages=${entry.messagesBefore}->${entry.messagesAfter}`;
  }

  if (entry.type === 'usage') {
    return `#${index} ${entry.entryId} type=usage source=${entry.source} parent=${entry.parentEntryId ?? 'root'} total=${entry.usage.total_tokens}`;
  }

  if (entry.type === 'branch_summary') {
    return `#${index} ${entry.entryId} type=branch_summary parent=${entry.parentEntryId ?? 'root'} from=${entry.fromEntryId ?? 'root'} to=${entry.toEntryId} messages=${entry.messageCount}`;
  }

  return `#${index} ${entry.entryId} type=leaf parent=${entry.parentEntryId ?? 'root'} target=${entry.targetEntryId ?? 'root'}`;
}

function writeEntryPath({
  entries,
  writeLine,
}: {
  entries: SessionPathEntry[];
  writeLine: (message?: string) => void;
}): void {
  entries.forEach((entry, index) => {
    const activeMarker = index === entries.length - 1 ? '*' : ' ';
    writeLine(`  ${activeMarker} ${getPathEntryLabel(entry, index)}`);
  });
}

function formatBranchSummary(summary: SessionBranchSummary): string {
  const target = summary.targetEntry;
  const role = target.messageRole ? ` role=${target.messageRole}` : '';
  const kind = target.kind ? ` kind=${target.kind}` : '';
  const messageIndex = typeof target.messageIndex === 'number' ? ` message_index=${target.messageIndex}` : '';
  const preview = target.preview ? ` preview="${target.preview}"` : '';
  return `Path entries: ${summary.pathEntryCount}, messages: ${summary.messageCount}, target: ${target.entryId} type=${target.type}${role}${kind}${messageIndex}${preview}`;
}

function formatBranchError(error: unknown, leafEntryId: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Entry not found in session/i.test(message)) {
    return `Entry not found: ${leafEntryId}. Run /entries to inspect available entry ids.`;
  }
  if (/Entry path has no messages/i.test(message)) {
    return `Entry path has no messages: ${leafEntryId}. Choose a message entry from /entries.`;
  }
  if (/Session not found/i.test(message)) {
    return `Session not found while branching: ${message}`;
  }
  return `Branch failed: ${message}`;
}

function getSessionLoadDiagnostic(diagnostics: RuntimeDiagnostic[], sessionId: string): RuntimeDiagnostic | undefined {
  const loadCodes = new Set([
    'session_load_invalid_log',
    'session_load_no_messages',
    'session_load_failed',
    'session_log_unsupported_schema',
    'session_log_missing_session_start',
    'session_log_missing_entry_metadata',
    'session_log_active_leaf_missing',
    'session_log_broken_parent_chain',
  ]);
  let latest: RuntimeDiagnostic | undefined;
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.source === 'session'
      && diagnostic.details?.['sessionId'] === sessionId
      && loadCodes.has(diagnostic.code)
    ) {
      latest = diagnostic;
    }
  }
  return latest;
}

function writeSessionNotFoundError(
  error: RuntimeSessionNotFoundError,
  writeLine: (message?: string) => void,
): void {
  const diagnostic = getSessionLoadDiagnostic(error.diagnostics, error.sessionId);
  if (!diagnostic) {
    writeLine(`${Colors.RED}❌ Session not found: ${error.sessionId}${Colors.RESET}\n`);
    return;
  }
  writeLine(`${Colors.RED}❌ Session could not be loaded: ${error.sessionId}${Colors.RESET}`);
  writeLine(`${Colors.DIM}${diagnostic.message}${Colors.RESET}\n`);
}

function parseSkillCommand(command: string, args: string[]): string | null {
  if (command.toLowerCase().startsWith('/skill:')) {
    return command.slice('/skill:'.length).trim() || null;
  }
  if (command.toLowerCase() === '/skill') {
    return args[0]?.trim() || null;
  }
  return null;
}

function writeAvailableSkills(host: RuntimeHost, writeLine: (message?: string) => void): void {
  const skills = host.runtime.services.resourceLoader.skills;
  if (!skills.length) {
    writeLine(`${Colors.YELLOW}No skills loaded.${Colors.RESET}\n`);
    return;
  }

  writeLine(`\n${Colors.BRIGHT_CYAN}Available skills:${Colors.RESET}`);
  for (const skill of skills) {
    const hidden = skill.disableModelInvocation ? ' hidden' : '';
    writeLine(`  ${skill.name}${hidden} - ${skill.description}`);
  }
  writeLine();
}

function parseSessionForkArgs(args: string[]): { sessionId?: string; leafEntryId?: string } {
  let sessionId: string | undefined;
  let leafEntryId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--entry' || arg === '--leaf') {
      leafEntryId = args[index + 1];
      index += 1;
      continue;
    }
    if (!sessionId) {
      sessionId = arg;
    }
  }

  return { sessionId, leafEntryId };
}

export async function handleInteractiveCommand({
  userInput,
  host,
  writeLine = console.log,
}: {
  userInput: string;
  host: RuntimeHost;
  writeLine?: (message?: string) => void;
}): Promise<InteractiveCommandResult> {
  if (!userInput.startsWith('/')) return 'not_command';

  const [command = '', ...args] = userInput.split(/\s+/);
  const cmd = command.toLowerCase();

  if (['/exit', '/quit', '/q'].includes(cmd)) {
    writeLine(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eva AI${Colors.RESET}\n`);
    return 'exit';
  }

  if (cmd === '/new') {
    const previousSessionId = host.sessionId;
    await host.newSession();
    writeLine(`${Colors.GREEN}✅ Created new session: ${host.sessionId}${Colors.RESET}`);
    writeLine(`${Colors.DIM}Previous session: ${previousSessionId}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/resume') {
    const previousSessionId = host.sessionId;
    try {
      if (args.length === 0) {
        await host.resumeLatestSession();
        writeLine(`${Colors.GREEN}✅ Resumed latest session: ${host.sessionId}${Colors.RESET}`);
      } else {
        await host.switchSession(args[0]);
        writeLine(`${Colors.GREEN}✅ Resumed session: ${host.sessionId}${Colors.RESET}`);
      }
      writeLine(`${Colors.DIM}Previous session: ${previousSessionId}${Colors.RESET}\n`);
    } catch (e) {
      if (e instanceof RuntimeSessionNotFoundError) {
        writeSessionNotFoundError(e, writeLine);
      } else {
        throw e;
      }
    }
    return 'continue';
  }

  if (cmd === '/fork') {
    const previousSessionId = host.sessionId;
    const { sessionId: requestedSessionId, leafEntryId } = parseSessionForkArgs(args);
    await host.forkSession(requestedSessionId, leafEntryId);
    writeLine(`${Colors.GREEN}✅ Forked session: ${host.sessionId}${Colors.RESET}`);
    writeLine(`${Colors.DIM}Parent session: ${previousSessionId}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/clone') {
    const previousSessionId = host.sessionId;
    const { sessionId: requestedSessionId, leafEntryId } = parseSessionForkArgs(args);
    await host.cloneSession(requestedSessionId, leafEntryId);
    writeLine(`${Colors.GREEN}✅ Cloned session: ${host.sessionId}${Colors.RESET}`);
    writeLine(`${Colors.DIM}Source session: ${previousSessionId}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/branch') {
    const leafEntryId = args[0];
    if (!leafEntryId) {
      writeLine(`${Colors.RED}❌ Branch requires an entry id: /branch <entryId>${Colors.RESET}\n`);
      return 'continue';
    }
    let summary: SessionBranchSummary;
    try {
      summary = await host.branchSession(leafEntryId);
    } catch (error) {
      writeLine(`${Colors.RED}❌ ${formatBranchError(error, leafEntryId)}${Colors.RESET}\n`);
      return 'continue';
    }
    writeLine(`${Colors.GREEN}✅ Branched current session at entry: ${leafEntryId}${Colors.RESET}`);
    writeLine(`${Colors.DIM}${formatBranchSummary(summary)}${Colors.RESET}`);
    writeLine(`${Colors.DIM}Session: ${host.sessionId}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/parent') {
    const previousSessionId = host.sessionId;
    const parentRuntime = await host.switchToParentSession();
    if (!parentRuntime) {
      writeLine(`${Colors.YELLOW}No parent session for current session: ${previousSessionId}${Colors.RESET}\n`);
      return 'continue';
    }
    writeLine(`${Colors.GREEN}✅ Switched to parent session: ${host.sessionId}${Colors.RESET}`);
    writeLine(`${Colors.DIM}Previous session: ${previousSessionId}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/children') {
    const childSessions = await host.listChildSessions();
    if (!childSessions.length) {
      writeLine(`${Colors.YELLOW}No child sessions for current session: ${host.sessionId}${Colors.RESET}\n`);
      return 'continue';
    }

    writeLine(`\n${Colors.BRIGHT_CYAN}Child sessions:${Colors.RESET}`);
    writeChildSessions({ sessions: childSessions, writeLine });
    writeLine();
    return 'continue';
  }

  if (cmd === '/child') {
    const previousSessionId = host.sessionId;
    const requestedSessionId = args[0];
    try {
      const childRuntime = await host.switchToChildSession(requestedSessionId);
      if (!childRuntime) {
        writeLine(`${Colors.YELLOW}No child sessions for current session: ${previousSessionId}${Colors.RESET}\n`);
        return 'continue';
      }
      writeLine(`${Colors.GREEN}✅ Switched to child session: ${host.sessionId}${Colors.RESET}`);
      writeLine(`${Colors.DIM}Previous session: ${previousSessionId}${Colors.RESET}\n`);
    } catch (e) {
      if (e instanceof RuntimeChildSessionAmbiguousError) {
        writeLine(`${Colors.YELLOW}Multiple child sessions found. Use /child <sessionId>.${Colors.RESET}`);
        writeChildSessions({ sessions: e.childSessions, writeLine });
        writeLine();
      } else if (e instanceof RuntimeChildSessionNotFoundError) {
        writeLine(`${Colors.RED}❌ Child session not found: ${e.sessionId}${Colors.RESET}\n`);
      } else {
        throw e;
      }
    }
    return 'continue';
  }

  if (cmd === '/export') {
    const outputPath = args[0];
    const exportedPath = await host.exportSession(outputPath);
    writeLine(`${Colors.GREEN}✅ Exported session: ${host.sessionId}${Colors.RESET}`);
    writeLine(`${Colors.BRIGHT_CYAN}Path:${Colors.RESET} ${exportedPath}\n`);
    return 'continue';
  }

  if (cmd === '/import') {
    const inputPath = args[0];
    if (!inputPath) {
      writeLine(`${Colors.RED}❌ Import requires a JSONL path${Colors.RESET}\n`);
      return 'continue';
    }
    const previousSessionId = host.sessionId;
    try {
      await host.importSession(inputPath);
      writeLine(`${Colors.GREEN}✅ Imported session: ${host.sessionId}${Colors.RESET}`);
      writeLine(`${Colors.DIM}Previous session: ${previousSessionId}${Colors.RESET}\n`);
    } catch (e) {
      writeLine(`${Colors.RED}❌ Import failed: ${(e as Error).message}${Colors.RESET}\n`);
    }
    return 'continue';
  }

  if (cmd === '/clear') {
    const old = host.session.messages.length;
    await host.session.clear();
    writeLine(`${Colors.GREEN}✅ Cleared ${old - 1} messages, starting new session${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/compact') {
    const customInstructions = userInput.slice(command.length).trim() || undefined;
    try {
      const result = await host.session.compact(customInstructions);
      writeLine(`${Colors.GREEN}✅ Compacted current session${Colors.RESET}`);
      writeLine(
        `${Colors.BRIGHT_CYAN}Messages:${Colors.RESET} ${result.messagesBefore} -> ${result.messagesAfter}`,
      );
      writeLine(
        `${Colors.BRIGHT_CYAN}Kept from message index:${Colors.RESET} ${result.firstKeptMessageIndex}`,
      );
      writeLine();
    } catch (e) {
      writeLine(`${Colors.RED}❌ Compact failed: ${(e as Error).message}${Colors.RESET}\n`);
    }
    return 'continue';
  }

  if (cmd === '/skill' || cmd.startsWith('/skill:')) {
    const skillName = parseSkillCommand(command, args);
    if (!skillName) {
      writeAvailableSkills(host, writeLine);
      return 'continue';
    }

    const result = host.runtime.services.contextBuilder.queueSkillInvocation(skillName);
    if (!result.ok) {
      writeLine(`${Colors.RED}❌ Skill not found: ${result.skillName}${Colors.RESET}`);
      if (result.availableSkills.length > 0) {
        writeLine(`${Colors.DIM}Available skills: ${result.availableSkills.join(', ')}${Colors.RESET}\n`);
      } else {
        writeLine(`${Colors.DIM}No skills loaded.${Colors.RESET}\n`);
      }
      return 'continue';
    }

    writeLine(`${Colors.GREEN}✅ Queued skill for next request: ${result.skill.name}${Colors.RESET}`);
    writeLine(`${Colors.DIM}${result.skill.path}${Colors.RESET}\n`);
    return 'continue';
  }

  if (cmd === '/history') {
    writeLine(`\n${Colors.BRIGHT_CYAN}Current session:${Colors.RESET} ${host.sessionId}`);
    writeLine(`${Colors.BRIGHT_CYAN}Message count:${Colors.RESET} ${host.session.messages.length}\n`);
    return 'continue';
  }

  if (cmd === '/stats') {
    writeLine(`\n${Colors.BRIGHT_CYAN}Session:${Colors.RESET} ${host.sessionId}`);
    writeLine(`${Colors.BRIGHT_CYAN}Messages:${Colors.RESET} ${host.session.messages.length}`);
    writeLine(`${Colors.BRIGHT_CYAN}API total tokens:${Colors.RESET} ${host.session.apiTotalTokens}`);
    writeLine(`${Colors.BRIGHT_CYAN}Provider:${Colors.RESET} ${host.runtime.config.llm.provider}`);
    writeLine(`${Colors.BRIGHT_CYAN}Model:${Colors.RESET} ${host.runtime.config.llm.model}`);
    writeLine(`${Colors.BRIGHT_CYAN}Tools:${Colors.RESET} ${host.runtime.tools.length}`);
    const contextDiagnostics = await getContextDiagnostics(host);
    if (contextDiagnostics) {
      writeLine(`${Colors.BRIGHT_CYAN}Step guard:${Colors.RESET} ${formatStepGuard(contextDiagnostics.stepGuard)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Compaction:${Colors.RESET} ${formatCompactionStatus(contextDiagnostics.compaction)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Token usage:${Colors.RESET} ${formatUsageStatus(contextDiagnostics.usage)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Latest usage:${Colors.RESET} ${formatLatestUsageStatus(contextDiagnostics.usage)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Context usage:${Colors.RESET} ${formatContextUsageStatus(contextDiagnostics)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Compaction recommendation:${Colors.RESET} ${formatCompactionRecommendationStatus(contextDiagnostics)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Estimated tokens:${Colors.RESET} ${formatTokenEstimateStatus(contextDiagnostics)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Project context:${Colors.RESET} ${contextDiagnostics.projectContext.count}`);
      writeLine(`${Colors.BRIGHT_CYAN}Skills:${Colors.RESET} ${formatSkillsStatus(contextDiagnostics)}`);
      writeLine(`${Colors.BRIGHT_CYAN}Context build:${Colors.RESET} ${formatContextBuildStatus(contextDiagnostics.latestBuild)}`);
    }
    writeLine();
    return 'continue';
  }

  if (cmd === '/diagnostics') {
    const sessionDiagnostics = host.runtime.sessionManager?.getDiagnostics?.() ?? [];
    const diagnostics = [
      ...host.runtime.diagnostics,
      ...sessionDiagnostics,
    ];
    writeLine(`\n${Colors.BRIGHT_CYAN}Runtime diagnostics:${Colors.RESET}`);
    if (!diagnostics.length) {
      writeLine(`${Colors.DIM}No diagnostics recorded.${Colors.RESET}\n`);
      return 'continue';
    }
    for (const diagnostic of diagnostics) {
      const color =
        diagnostic.level === 'error'
          ? Colors.RED
          : diagnostic.level === 'warning'
            ? Colors.YELLOW
            : Colors.DIM;
      writeLine(`${color}${formatRuntimeDiagnostic(diagnostic)}${Colors.RESET}`);
    }
    const contextDiagnostics = await getContextDiagnostics(host);
    if (contextDiagnostics) {
      writeLine();
      writeContextDiagnostics(contextDiagnostics, writeLine);
    }
    writeLine();
    return 'continue';
  }

  if (cmd === '/reload') {
    const result = await host.reloadResources();
    writeLine(`${Colors.GREEN}✅ Reloaded runtime resources${Colors.RESET}`);
    writeLine(`${Colors.BRIGHT_CYAN}Project context:${Colors.RESET} ${result.resourceLoader.projectContext.length}`);
    writeLine(`${Colors.BRIGHT_CYAN}Skills:${Colors.RESET} ${result.resourceLoader.skills.length}`);
    writeLine(`${Colors.BRIGHT_CYAN}System prompt:${Colors.RESET} ${result.systemPromptPath ?? 'default'}`);
    writeLine();
    return 'continue';
  }

  if (cmd === '/sessions') {
    const sessionTree = await host.runtime.sessionManager.listSessionTree();
    if (!sessionTree.length) {
      writeLine(`\n${Colors.YELLOW}No sessions found for this workspace.${Colors.RESET}\n`);
      return 'continue';
    }

    writeLine(`\n${Colors.BRIGHT_CYAN}Workspace session tree:${Colors.RESET}`);
    writeSessionTree({
      nodes: sessionTree,
      currentSessionId: host.sessionId,
      writeLine,
    });
    writeLine();
    return 'continue';
  }

  if (cmd === '/entries') {
    const entryTree = host.runtime.sessionManager.listEntryTree(host.sessionId);
    if (!entryTree.length) {
      writeLine(`\n${Colors.YELLOW}No entry tree metadata found for current session.${Colors.RESET}\n`);
      return 'continue';
    }

    writeLine(`\n${Colors.BRIGHT_CYAN}Current session entries:${Colors.RESET}`);
    writeEntryTree({ nodes: entryTree, writeLine });
    writeLine();
    return 'continue';
  }

  if (cmd === '/path') {
    const entryPath = host.runtime.sessionManager.getEntryPath(host.sessionId);
    if (!entryPath.length) {
      writeLine(`\n${Colors.YELLOW}No active entry path found for current session.${Colors.RESET}\n`);
      return 'continue';
    }

    writeLine(`\n${Colors.BRIGHT_CYAN}Current active entry path:${Colors.RESET}`);
    writeEntryPath({ entries: entryPath, writeLine });
    writeLine();
    return 'continue';
  }

  if (cmd === '/log' || cmd.startsWith('/log ')) {
    return 'continue';
  }

  writeLine(`${Colors.RED}❌ Unknown command: ${userInput}${Colors.RESET}`);
  writeLine(`${Colors.DIM}Type /help to see available commands${Colors.RESET}\n`);
  return 'continue';
}

export async function runInteractiveMode({
  host,
  setToolConfirmationHandler,
}: InteractiveModeOptions): Promise<void> {
  const renderEvent = createCliRenderer({ tools: host.runtime.tools });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
  });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  setToolConfirmationHandler(createToolConfirmationPrompt(prompt));

  let abortController: AbortController | null = null;

  rl.on('SIGINT', () => {
    console.log(`\n\n${Colors.BRIGHT_YELLOW}👋 Interrupt signal detected, exiting...${Colors.RESET}\n`);
    rl.close();
    process.exit(0);
  });

  while (true) {
    let userInput: string;
    try {
      userInput = (await prompt(`${Colors.BRIGHT_GREEN}You${Colors.RESET} › `)).trim();
    } catch {
      break;
    }

    if (!userInput) continue;

    const commandResult = await handleInteractiveCommand({ userInput, host });
    if (commandResult === 'exit') break;
    if (commandResult === 'continue') {
      continue;
    }

    if (['exit', 'quit', 'q'].includes(userInput.toLowerCase())) {
      console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eva AI${Colors.RESET}\n`);
      break;
    }

    console.log(
      `\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Thinking... (Ctrl+C to cancel)${Colors.RESET}\n`,
    );

    await host.session.addUserMessage(userInput);
    abortController = new AbortController();

    try {
      await host.session.run({
        signal: abortController.signal,
        onEvent: renderEvent,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  Agent execution cancelled${Colors.RESET}`);
      } else {
        console.log(`\n${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
      }
    } finally {
      abortController = null;
    }

    console.log(`\n${Colors.DIM}${'─'.repeat(60)}${Colors.RESET}\n`);
  }

  rl.close();
}
