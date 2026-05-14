import * as readline from 'node:readline';
import { RuntimeSessionNotFoundError, type ToolConfirmationRequest, type ToolPermissionDecision } from '../core/runtime.js';
import type { ContextBuildSummary } from '../core/context-builder.js';
import type { ContextDiagnostics } from '../core/context-manager.js';
import type { RuntimeHost } from '../core/runtime-host.js';
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
    return `not injected${reason}, provider request messages=${latestBuild.providerRequestMessageCount}, estimated provider request tokens=${latestBuild.providerRequestTokenEstimate.tokens}, ${budget}`;
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

function formatPermissionPendingStatus(diagnostics: ContextDiagnostics): string {
  const pending = diagnostics.permissionPending;
  if (!pending.count) return 'none';
  const metadata = pending.latest?.metadata ?? {};
  const toolName = typeof metadata['toolName'] === 'string' ? metadata['toolName'] : 'unknown';
  const reason = pending.latest?.content ?? 'permission pending';
  return `count=${pending.count}, latest tool=${toolName}, reason=${reason}`;
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
  writeLine(`  Permission pending: ${formatPermissionPendingStatus(diagnostics)}`);
  writeLine(`  Estimated tokens: ${formatTokenEstimateStatus(diagnostics)}`);
  writeLine(`  Project context resources: ${diagnostics.projectContext.count}`);
  for (const resource of diagnostics.projectContext.resources) {
    writeLine(`  - ${resource.name} path=${resource.path} chars=${resource.content.length}`);
  }
  writeLine(`  Budget: ${diagnostics.projectContext.budgetChars} chars`);
  writeLine(`  Last build: ${formatContextBuildStatus(diagnostics.latestBuild)}`);
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
        writeLine(`${Colors.RED}❌ Session not found: ${e.sessionId}${Colors.RESET}\n`);
      } else {
        throw e;
      }
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
      writeLine(`${Colors.BRIGHT_CYAN}Context build:${Colors.RESET} ${formatContextBuildStatus(contextDiagnostics.latestBuild)}`);
    }
    writeLine();
    return 'continue';
  }

  if (cmd === '/diagnostics') {
    const diagnostics = host.runtime.diagnostics;
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
    writeLine(`${Colors.BRIGHT_CYAN}System prompt:${Colors.RESET} ${result.systemPromptPath ?? 'default'}`);
    writeLine();
    return 'continue';
  }

  if (cmd === '/sessions') {
    const sessions = await host.runtime.sessionManager.listSessions();
    if (!sessions.length) {
      writeLine(`\n${Colors.YELLOW}No sessions found for this workspace.${Colors.RESET}\n`);
      return 'continue';
    }

    writeLine(`\n${Colors.BRIGHT_CYAN}Workspace sessions:${Colors.RESET}`);
    for (const session of sessions) {
      const currentMarker = session.sessionId === host.sessionId ? '*' : ' ';
      const latestMarker = session.isLatest ? ' latest' : '';
      const updatedAt = session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : 'unknown';
      writeLine(
        `${currentMarker} ${session.sessionId} messages=${session.messageCount} updated=${updatedAt}${latestMarker}`,
      );
    }
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
  const renderEvent = createCliRenderer();
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
