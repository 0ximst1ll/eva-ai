import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
// import { program } from 'commander';
import { Agent } from './agent.js';
import { Config } from './config.js';
import { LLMProvider } from './schema.js';
import { LLMClient } from './llm/llm-client.js';
import { RetryConfig } from './retry.js';
// import { ReadTool, WriteTool, EditTool } from './tools/file-tools.js';
// import { BashTool, BashOutputTool, BashKillTool } from './tools/bash-tool.js';
// import { SessionNoteTool } from './tools/note-tool.js';
// import { createSkillTools } from './tools/skill-tool.js';
// import { loadMcpToolsAsync, cleanupMcpConnections, setMcpTimeoutConfig } from './tools/mcp-loader.js';
import type { Tool } from './tools/base.js';
import { Colors, calculateDisplayWidth } from './utils/terminal.js';


// ============ Tool initialization ============

// async function initializeBaseTools(config: ReturnType<typeof Config.fromYaml>): Promise<{
//   tools: Tool[];
//   skillLoader: ReturnType<typeof createSkillTools>['loader'] | null;
// }> {
//   const tools: Tool[] = [];
//   let skillLoader: ReturnType<typeof createSkillTools>['loader'] | null = null;

//   // Bash auxiliary tools
//   if (config.tools.enableBash) {
//     tools.push(new BashOutputTool(), new BashKillTool());
//     console.log(`${Colors.GREEN}✅ Loaded Bash Output tool${Colors.RESET}`);
//     console.log(`${Colors.GREEN}✅ Loaded Bash Kill tool${Colors.RESET}`);
//   }

//   // Claude Skills
//   if (config.tools.enableSkills) {
//     console.log(`${Colors.BRIGHT_CYAN}Loading Claude Skills...${Colors.RESET}`);
//     try {
//       const skillsPath = config.tools.skillsDir.replace(/^~/, os.homedir());
//       const searchPaths = [
//         skillsPath,
//         path.join('mini_agent', skillsPath),
//         path.join(Config.getPackageDir(), '..', skillsPath),
//       ];

//       let skillsDir = skillsPath;
//       for (const p of searchPaths) {
//         if (fs.existsSync(p)) {
//           skillsDir = path.resolve(p);
//           break;
//         }
//       }

//       const { tools: skillTools, loader } = createSkillTools(skillsDir);
//       if (skillTools.length) {
//         tools.push(...skillTools);
//         skillLoader = loader;
//         console.log(`${Colors.GREEN}✅ Loaded Skill tool (get_skill)${Colors.RESET}`);
//       } else {
//         console.log(`${Colors.YELLOW}⚠️  No available Skills found${Colors.RESET}`);
//       }
//     } catch (e) {
//       console.log(`${Colors.YELLOW}⚠️  Failed to load Skills: ${e}${Colors.RESET}`);
//     }
//   }

//   // MCP tools
//   if (config.tools.enableMcp) {
//     console.log(`${Colors.BRIGHT_CYAN}Loading MCP tools...${Colors.RESET}`);
//     try {
//       setMcpTimeoutConfig({
//         connectTimeout: config.tools.mcp.connectTimeout,
//         executeTimeout: config.tools.mcp.executeTimeout,
//         sseReadTimeout: config.tools.mcp.sseReadTimeout,
//       });

//       const mcpConfigPath = Config.findConfigFile(config.tools.mcpConfigPath);
//       if (mcpConfigPath) {
//         const mcpTools = await loadMcpToolsAsync(mcpConfigPath);
//         if (mcpTools.length) {
//           tools.push(...mcpTools);
//           console.log(`${Colors.GREEN}✅ Loaded ${mcpTools.length} MCP tools (from: ${mcpConfigPath})${Colors.RESET}`);
//         } else {
//           console.log(`${Colors.YELLOW}⚠️  No available MCP tools found${Colors.RESET}`);
//         }
//       } else {
//         console.log(`${Colors.YELLOW}⚠️  MCP config file not found: ${config.tools.mcpConfigPath}${Colors.RESET}`);
//       }
//     } catch (e) {
//       console.log(`${Colors.YELLOW}⚠️  Failed to load MCP tools: ${e}${Colors.RESET}`);
//     }
//   }

//   console.log();
//   return { tools, skillLoader };
// }

// function addWorkspaceTools(
//   tools: Tool[],
//   config: ReturnType<typeof Config.fromYaml>,
//   workspaceDir: string,
// ): void {
//   fs.mkdirSync(workspaceDir, { recursive: true });

//   if (config.tools.enableBash) {
//     tools.push(new BashTool(workspaceDir));
//     console.log(`${Colors.GREEN}✅ Loaded Bash tool (cwd: ${workspaceDir})${Colors.RESET}`);
//   }

//   if (config.tools.enableFileTools) {
//     tools.push(
//       new ReadTool(workspaceDir),
//       new WriteTool(workspaceDir),
//       new EditTool(workspaceDir),
//     );
//     console.log(`${Colors.GREEN}✅ Loaded file operation tools (workspace: ${workspaceDir})${Colors.RESET}`);
//   }

//   if (config.tools.enableNote) {
//     tools.push(new SessionNoteTool(path.join(workspaceDir, '.agent_memory.json')));
//     console.log(`${Colors.GREEN}✅ Loaded session note tool${Colors.RESET}`);
//   }
// }


async function runAgent(workspaceDir: string, task?: string): Promise<void> {
  const sessionStart = new Date();

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

  // 6. Create agent
  const agent = new Agent({
    llmClient,
    systemPrompt,
    tools,
    maxSteps: config.agent.maxSteps,
    workspaceDir,
  });

  // 7. Non-interactive mode
  if (task) {
    console.log(`\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Executing task...${Colors.RESET}\n`);
    agent.addUserMessage(task);
    try {
      await agent.run();
    } catch (e) {
      console.log(`\n${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    } finally {
      // printStats(agent, sessionStart);
    }
    // await cleanupMcpConnections();
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
    // printStats(agent, sessionStart);
    rl.close();
    // cleanupMcpConnections().catch(() => {});
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
        // printStats(agent, sessionStart);
        break;
      }

      // if (cmd === '/help') { printHelp(); continue; }

      if (cmd === '/clear') {
        const old = agent.messages.length;
        agent.messages = [agent.messages[0]];
        console.log(`${Colors.GREEN}✅ Cleared ${old - 1} messages, starting new session${Colors.RESET}\n`);
        continue;
      }

      if (cmd === '/history') {
        console.log(`\n${Colors.BRIGHT_CYAN}Current session message count: ${agent.messages.length}${Colors.RESET}\n`);
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
      // printStats(agent, sessionStart);
      break;
    }

    // Run agent
    console.log(
      `\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Thinking... (Ctrl+C to cancel)${Colors.RESET}\n`,
    );

    agent.addUserMessage(userInput);
    abortController = new AbortController();

    try {
      await agent.run(abortController.signal);
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
  // await cleanupMcpConnections();
}

const workspaceDir = process.cwd();

fs.mkdirSync(workspaceDir, { recursive: true });

await runAgent(workspaceDir);
