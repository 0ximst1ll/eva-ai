import * as readline from 'node:readline';
import type { ToolConfirmationRequest } from '../core/runtime.js';
import type { RuntimeHost } from '../core/runtime-host.js';
import { Colors } from '../utils/terminal.js';
import { createCliRenderer, createToolConfirmationPrompt } from './cli-ui.js';

export interface InteractiveModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<boolean>) => void;
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

    if (userInput.startsWith('/')) {
      const cmd = userInput.toLowerCase();

      if (['/exit', '/quit', '/q'].includes(cmd)) {
        console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eva AI${Colors.RESET}\n`);
        break;
      }

      if (cmd === '/clear') {
        const old = host.session.messages.length;
        await host.session.clear();
        console.log(`${Colors.GREEN}✅ Cleared ${old - 1} messages, starting new session${Colors.RESET}\n`);
        continue;
      }

      if (cmd === '/history') {
        console.log(`\n${Colors.BRIGHT_CYAN}Current session message count: ${host.session.messages.length}${Colors.RESET}\n`);
        continue;
      }

      if (cmd === '/log' || cmd.startsWith('/log ')) {
        continue;
      }

      console.log(`${Colors.RED}❌ Unknown command: ${userInput}${Colors.RESET}`);
      console.log(`${Colors.DIM}Type /help to see available commands${Colors.RESET}\n`);
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
