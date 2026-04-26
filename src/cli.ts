import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { Config } from './config.js';
import { LLMProvider, type AgentSessionEvent } from './schema.js';
import { LLMClient } from './llm/llm-client.js';
import { RetryConfig } from './retry.js';
import type { Tool } from './tools/base.js';
import { AgentSession } from './core/agent-session.js';
import { SessionManager } from './core/session-manager.js';
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

async function runAgent(workspaceDir: string, task?: string): Promise<void> {
  // 1. Load config
  const configPath = Config.getDefaultConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log(`${Colors.RED}❌ Configuration file not found${Colors.RESET}`);
    console.log(`\n${Colors.BRIGHT_YELLOW}📝 Manual Setup:${Colors.RESET}`);
    const userConfigDir = path.join(os.homedir(), '.eve-agent', 'config');
    console.log(`  ${Colors.DIM}mkdir -p ${userConfigDir}${Colors.RESET}`);
    console.log(`  ${Colors.DIM}# Place config.yaml in ${userConfigDir}${Colors.RESET}`);
    return;
  }

  let config: ReturnType<typeof Config.fromYaml>;
  try {
    config = Config.fromYaml(configPath);
  } catch (e) {
    console.log(`${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    return;
  }

  // 2. Initialize LLM client
  const retryConfig = new RetryConfig({
    enabled: config.llm.retry.enabled,
    maxRetries: config.llm.retry.maxRetries,
    initialDelay: config.llm.retry.initialDelay,
    maxDelay: config.llm.retry.maxDelay,
    exponentialBase: config.llm.retry.exponentialBase,
  });

  const providerMap: Record<string, LLMProvider> = {
    anthropic: LLMProvider.ANTHROPIC,
    openai: LLMProvider.OPENAI,
    google: LLMProvider.GOOGLE,
  };
  const provider = providerMap[config.llm.provider.toLowerCase()];
  if (!provider) {
    console.log(`${Colors.RED}❌ Unsupported provider: ${config.llm.provider}${Colors.RESET}`);
    return;
  }

  const llmClient = new LLMClient({
    apiKey: config.llm.apiKey,
    provider,
    apiBase: config.llm.apiBase,
    model: config.llm.model,
    retryConfig,
  });

  if (config.llm.retry.enabled) {
    llmClient.retryCallback = (err: Error, attempt: number) => {
      console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  LLM call failed (attempt ${attempt}): ${err.message}${Colors.RESET}`);
      const nextDelay = retryConfig.calculateDelay(attempt - 1);
      console.log(`${Colors.DIM}   Retrying in ${nextDelay.toFixed(1)}s (attempt ${attempt + 1})...${Colors.RESET}`);
    };
    console.log(`${Colors.GREEN}✅ LLM retry mechanism enabled (max ${config.llm.retry.maxRetries} retries)${Colors.RESET}`);
  }

  // 3. Initialize tools
  // const { tools, skillLoader } = await initializeBaseTools(config);
  // addWorkspaceTools(tools, config, workspaceDir);

  // 4. Load system prompt
  const systemPromptPath = Config.findConfigFile(config.agent.systemPromptPath);
  let systemPrompt: string;
  if (systemPromptPath && fs.existsSync(systemPromptPath)) {
    systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');
    console.log(`${Colors.GREEN}✅ Loaded system prompt (from: ${systemPromptPath})${Colors.RESET}`);
  } else {
    systemPrompt =
      'You are Eve-Agent, an intelligent assistant that can help users complete various tasks.';
    console.log(`${Colors.YELLOW}⚠️  System prompt not found, using default${Colors.RESET}`);
  }

  // 5. Inject skills metadata (Progressive Disclosure Level 1)
  // if (skillLoader) {
  //   const meta = skillLoader.getSkillsMetadataPrompt();
  //   if (meta) {
  //     systemPrompt = systemPrompt.replace('{SKILLS_METADATA}', meta);
  //     console.log(`${Colors.GREEN}✅ Injected ${skillLoader.loadedSkills.size} skills metadata into system prompt${Colors.RESET}`);
  //   } else {
  //     systemPrompt = systemPrompt.replace('{SKILLS_METADATA}', '');
  //   }
  // } else {
  //   systemPrompt = systemPrompt.replace('{SKILLS_METADATA}', '');
  // }

  const tools: Tool[] = [];

  // 6. Create session manager + session
  const sessionManager = new SessionManager({ workspaceDir, mode: 'jsonl' });
  let sessionId = await sessionManager.loadLatestSession();
  if (!sessionId) {
    sessionId = await sessionManager.createSession(systemPrompt);
  }

  const session = new AgentSession({
    llmClient,
    systemPrompt,
    tools,
    maxSteps: config.agent.maxSteps,
    sessionManager,
    sessionId,
  });
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
        console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eve Agent${Colors.RESET}\n`);
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
      console.log(`\n${Colors.BRIGHT_YELLOW}👋 Goodbye! Thanks for using Eve Agent${Colors.RESET}\n`);
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
