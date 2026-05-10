import * as readline from 'node:readline';
import { RuntimeSessionNotFoundError, type ToolConfirmationRequest } from '../core/runtime.js';
import type { ContextBuilder } from '../core/context-builder.js';
import type { RuntimeHost } from '../core/runtime-host.js';
import { Colors } from '../utils/terminal.js';
import { createCliRenderer, createToolConfirmationPrompt, formatRuntimeDiagnostic } from './cli-ui.js';

export interface InteractiveModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<boolean>) => void;
}

export type InteractiveCommandResult = 'not_command' | 'continue' | 'exit';

function getContextBuilder(host: RuntimeHost): ContextBuilder | undefined {
  return host.runtime.services?.contextBuilder;
}

function formatContextBuildStatus(contextBuilder: ContextBuilder): string {
  const latestBuild = contextBuilder.latestBuild;
  if (!latestBuild) return 'not built yet';
  if (!latestBuild.injected) {
    const reason = latestBuild.projectContextSkippedReason
      ? `, reason=${latestBuild.projectContextSkippedReason}`
      : '';
    return `not injected${reason}, request messages=${latestBuild.requestMessageCount}, budget=${latestBuild.projectContextMaxChars}`;
  }
  const status = [
    `injected ${latestBuild.projectContextCount} resource(s)`,
    `request messages=${latestBuild.requestMessageCount}`,
    `chars=${latestBuild.projectContextContentLength}/${latestBuild.projectContextMaxChars}`,
  ];
  if (latestBuild.projectContextTruncated) status.push('truncated');
  return status.join(', ');
}

function formatStepGuard(maxSteps: number | null | undefined): string {
  return maxSteps ? `max_steps=${maxSteps}` : 'disabled';
}

function formatCompactionStatus(compaction: RuntimeHost['session']['compaction']): string {
  if (!compaction.compacted) return 'none';
  return `compacted messages ${compaction.messagesBefore} -> ${compaction.messagesAfter}, summary chars=${compaction.summaryLength}`;
}

function formatUsageStatus(usage: RuntimeHost['session']['usage']): string {
  if (!usage.count) return 'unknown';
  return [
    `calls=${usage.count}`,
    `prompt=${usage.total.prompt_tokens}`,
    `completion=${usage.total.completion_tokens}`,
    `total=${usage.total.total_tokens}`,
  ].join(', ');
}

function formatLatestUsageStatus(usage: RuntimeHost['session']['usage']): string {
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

function writeContextDiagnostics(
  contextBuilder: ContextBuilder,
  host: RuntimeHost,
  writeLine: (message?: string) => void,
): void {
  const compaction = host.session.compaction;
  const usage = host.session.usage;
  writeLine(`${Colors.BRIGHT_CYAN}Context:${Colors.RESET}`);
  writeLine(`  Active messages: ${host.session.messages.length}`);
  writeLine(`  Step guard: ${formatStepGuard(host.session.maxSteps)}`);
  writeLine(`  Compaction: ${formatCompactionStatus(compaction)}`);
  if (compaction.compacted) {
    writeLine(`  - First kept message index: ${compaction.firstKeptMessageIndex}`);
    writeLine(`  - Compacted at: ${compaction.timestamp ? new Date(compaction.timestamp).toISOString() : 'unknown'}`);
    writeLine(`  - Custom instructions: ${compaction.customInstructions ? 'yes' : 'no'}`);
  }
  writeLine(`  Token usage: ${formatUsageStatus(usage)}`);
  writeLine(`  Latest usage: ${formatLatestUsageStatus(usage)}`);
  writeLine(`  Project context resources: ${contextBuilder.projectContext.length}`);
  for (const resource of contextBuilder.projectContext) {
    writeLine(`  - ${resource.name} path=${resource.path} chars=${resource.content.length}`);
  }
  writeLine(`  Budget: ${contextBuilder.projectContextMaxChars} chars`);
  writeLine(`  Last build: ${formatContextBuildStatus(contextBuilder)}`);
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
    writeLine(`${Colors.BRIGHT_CYAN}Step guard:${Colors.RESET} ${formatStepGuard(host.session.maxSteps)}`);
    writeLine(`${Colors.BRIGHT_CYAN}Compaction:${Colors.RESET} ${formatCompactionStatus(host.session.compaction)}`);
    writeLine(`${Colors.BRIGHT_CYAN}Token usage:${Colors.RESET} ${formatUsageStatus(host.session.usage)}`);
    writeLine(`${Colors.BRIGHT_CYAN}Latest usage:${Colors.RESET} ${formatLatestUsageStatus(host.session.usage)}`);
    const contextBuilder = getContextBuilder(host);
    if (contextBuilder) {
      writeLine(`${Colors.BRIGHT_CYAN}Project context:${Colors.RESET} ${contextBuilder.projectContext.length}`);
      writeLine(`${Colors.BRIGHT_CYAN}Context build:${Colors.RESET} ${formatContextBuildStatus(contextBuilder)}`);
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
    const contextBuilder = getContextBuilder(host);
    if (contextBuilder) {
      writeLine();
      writeContextDiagnostics(contextBuilder, host, writeLine);
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
