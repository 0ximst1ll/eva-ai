import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { type AgentSessionEvent } from './schema.js';
import {
  createRuntime,
  RuntimeConfigNotFoundError,
  UnsupportedProviderError,
  type RuntimeDiagnostic,
} from './core/runtime.js';
import { Colors, calculateDisplayWidth } from './utils/terminal.js';

const BOX_WIDTH = 58;

type RenderState = {
  printedThinkingHeader: boolean;
  printedAssistantHeader: boolean;
};

function createCliRenderer() {
  let state: RenderState = {
    printedThinkingHeader: false,
    printedAssistantHeader: false,
  };

  return (event: AgentSessionEvent): void => {
    if (event.type === 'message_start') {
      state = { printedThinkingHeader: false, printedAssistantHeader: false };
      const stepText = `${Colors.BOLD}${Colors.BRIGHT_CYAN}💭 Step ${event.step}/${event.maxSteps}${Colors.RESET}`;
      const stepWidth = calculateDisplayWidth(stepText);
      const padding = Math.max(0, BOX_WIDTH - 1 - stepWidth);
      console.log(`\n${Colors.DIM}╭${'─'.repeat(BOX_WIDTH)}╮${Colors.RESET}`);
      console.log(`${Colors.DIM}│${Colors.RESET} ${stepText}${' '.repeat(padding)}${Colors.DIM}│${Colors.RESET}`);
      console.log(`${Colors.DIM}╰${'─'.repeat(BOX_WIDTH)}╯${Colors.RESET}`);
      return;
    }

    if (event.type === 'thinking_delta') {
      if (!state.printedThinkingHeader) {
        state.printedThinkingHeader = true;
        console.log(`\n${Colors.BOLD}${Colors.MAGENTA}🧠 Thinking:${Colors.RESET}`);
      }
      process.stdout.write(event.text);
      return;
    }

    if (event.type === 'content_delta') {
      if (!state.printedAssistantHeader) {
        state.printedAssistantHeader = true;
        console.log(`\n${Colors.BOLD}${Colors.BRIGHT_BLUE}🤖 Assistant:${Colors.RESET}`);
      }
      process.stdout.write(event.text);
      return;
    }

    if (event.type === 'tool_call') {
      console.log(
        `\n${Colors.BRIGHT_YELLOW}🔧 Tool Call:${Colors.RESET} ${Colors.BOLD}${Colors.CYAN}${event.tool_call.function.name}${Colors.RESET}`,
      );
      console.log(`${Colors.DIM}   Arguments:${Colors.RESET}`);
      const truncated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(event.tool_call.function.arguments)) {
        const s = String(v);
        truncated[k] = s.length > 200 ? s.slice(0, 200) + '...' : v;
      }
      for (const line of JSON.stringify(truncated, null, 2).split('\n')) {
        console.log(`   ${Colors.DIM}${line}${Colors.RESET}`);
      }
      return;
    }

    if (event.type === 'tool_result') {
      if (event.result.success) {
        let text = event.result.content;
        if (text.length > 300) text = text.slice(0, 300) + `${Colors.DIM}...${Colors.RESET}`;
        console.log(`${Colors.BRIGHT_GREEN}✓ Result:${Colors.RESET} ${text}`);
      } else {
        console.log(
          `${Colors.BRIGHT_RED}✗ Error:${Colors.RESET} ${Colors.RED}${event.result.error}${Colors.RESET}`,
        );
      }
      return;
    }

    if (event.type === 'usage') {
      return;
    }

    if (event.type === 'message_end') {
      if (state.printedThinkingHeader || state.printedAssistantHeader) {
        process.stdout.write('\n');
      }
      const stepElapsed = (event.elapsedMs / 1000).toFixed(2);
      const totalElapsed = (event.totalElapsedMs / 1000).toFixed(2);
      console.log(
        `\n${Colors.DIM}⏱️  Step ${event.step} completed in ${stepElapsed}s (total: ${totalElapsed}s)${Colors.RESET}`,
      );
      return;
    }

    if (event.type === 'error') {
      console.log(`\n${Colors.BRIGHT_RED}❌ Error:${Colors.RESET} ${event.message}`);
    }
  };
}

function renderRuntimeDiagnostics(diagnostics: RuntimeDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === 'retry_enabled') {
      console.log(`${Colors.GREEN}✅ ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    if (diagnostic.code === 'system_prompt_loaded') {
      console.log(`${Colors.GREEN}✅ ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    if (diagnostic.type === 'warning') {
      console.log(`${Colors.YELLOW}⚠️  ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    console.log(`${Colors.DIM}${diagnostic.message}${Colors.RESET}`);
  }
}

async function runAgent(workspaceDir: string, task?: string): Promise<void> {
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime({
      workspaceDir,
      onLlmRetry: ({ error, attempt, nextDelay }) => {
        console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  LLM call failed (attempt ${attempt}): ${error.message}${Colors.RESET}`);
        console.log(
          `${Colors.DIM}   Retrying in ${nextDelay.toFixed(1)}s (attempt ${attempt + 1})...${Colors.RESET}`,
        );
      },
    });
  } catch (e) {
    if (e instanceof RuntimeConfigNotFoundError) {
      console.log(`${Colors.RED}❌ Configuration file not found${Colors.RESET}`);
      console.log(`\n${Colors.BRIGHT_YELLOW}📝 Manual Setup:${Colors.RESET}`);
      console.log(`  ${Colors.DIM}mkdir -p ${e.userConfigDir}${Colors.RESET}`);
      console.log(`  ${Colors.DIM}# Place config.yaml in ${e.userConfigDir}${Colors.RESET}`);
      return;
    }

    if (e instanceof UnsupportedProviderError) {
      console.log(`${Colors.RED}❌ Unsupported provider: ${e.provider}${Colors.RESET}`);
      return;
    }

    console.log(`${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    return;
  }

  renderRuntimeDiagnostics(runtime.diagnostics);

  const { session } = runtime;
  const renderEvent = createCliRenderer();

  // 7. Non-interactive mode
  if (task) {
    console.log(`\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Executing task...${Colors.RESET}\n`);
    await session.addUserMessage(task);
    try {
      await session.run({ onEvent: renderEvent });
    } catch (e) {
      console.log(`\n${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    }
    return;
  }

  // 8. Interactive mode
  // printBanner();
  // printSessionInfo(agent, workspaceDir, config.llm.model);

  // Use Node.js readline for interactive input
  // Python uses prompt_toolkit; readline is simpler but fully functional.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
  });

  // Prompt helper — returns a Promise<string>
  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  // AbortController for cancellation (replaces Python's asyncio.Event + threading)
  let abortController: AbortController | null = null;

  // Handle Ctrl+C
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

    // Commands
    if (userInput.startsWith('/')) {
      const cmd = userInput.toLowerCase();

      if (['/exit', '/quit', '/q'].includes(cmd)) {
        console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eva AI${Colors.RESET}\n`);
        break;
      }

      // if (cmd === '/help') { printHelp(); continue; }

      if (cmd === '/clear') {
        const old = session.messages.length;
        await session.clear();
        console.log(`${Colors.GREEN}✅ Cleared ${old - 1} messages, starting new session${Colors.RESET}\n`);
        continue;
      }

      if (cmd === '/history') {
        console.log(`\n${Colors.BRIGHT_CYAN}Current session message count: ${session.messages.length}${Colors.RESET}\n`);
        continue;
      }

      // if (cmd === '/stats') { printStats(agent, sessionStart); continue; }

      if (cmd === '/log' || cmd.startsWith('/log ')) {
        const parts = userInput.split(/\s+/, 2);
        if (parts.length === 1) {
          // showLogDirectory();
        } else {
          // readLogFile(parts[1].replace(/['"]/g, ''));
        }
        continue;
      }

      console.log(`${Colors.RED}❌ Unknown command: ${userInput}${Colors.RESET}`);
      console.log(`${Colors.DIM}Type /help to see available commands${Colors.RESET}\n`);
      continue;
    }

    // Plain exit keywords
    if (['exit', 'quit', 'q'].includes(userInput.toLowerCase())) {
      console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eva AI${Colors.RESET}\n`);
      break;
    }

    // Run agent
    console.log(
      `\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Thinking... (Ctrl+C to cancel)${Colors.RESET}\n`,
    );

    await session.addUserMessage(userInput);
    abortController = new AbortController();

    try {
      await session.run({
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

const workspaceDir = process.cwd();

fs.mkdirSync(workspaceDir, { recursive: true });

await runAgent(workspaceDir);
