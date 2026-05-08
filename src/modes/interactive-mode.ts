import * as readline from 'node:readline';
import { RuntimeSessionNotFoundError, type ToolConfirmationRequest } from '../core/runtime.js';
import type { RuntimeHost } from '../core/runtime-host.js';
import { Colors } from '../utils/terminal.js';
import { createCliRenderer, createToolConfirmationPrompt } from './cli-ui.js';

export interface InteractiveModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<boolean>) => void;
}

export type InteractiveCommandResult = 'not_command' | 'continue' | 'exit';

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
    writeLine(`${Colors.BRIGHT_CYAN}Tools:${Colors.RESET} ${host.runtime.tools.length}\n`);
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
