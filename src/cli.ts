import * as fs from 'node:fs';
import {
  RuntimeConfigNotFoundError,
  UnsupportedProviderError,
  type ToolPermissionDecision,
  type ToolConfirmationRequest,
} from './core/runtime.js';
import { RuntimeHost } from './core/runtime-host.js';
import { renderRuntimeDiagnostics, runInteractiveMode, runPrintMode } from './modes/index.js';
import { Colors } from './utils/terminal.js';

let askToolConfirmation: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined;

async function createHost(workspaceDir: string, maxSteps?: number | null): Promise<RuntimeHost | null> {

  try {
    const host = await RuntimeHost.create({
      workspaceDir,
      maxSteps,
      confirmToolCall: (request) => askToolConfirmation?.(request) ?? 'ask',
      onLlmRetry: ({ error, attempt, nextDelay }) => {
        console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  LLM call failed (attempt ${attempt}): ${error.message}${Colors.RESET}`);
        console.log(
          `${Colors.DIM}   Retrying in ${nextDelay.toFixed(1)}s (attempt ${attempt + 1})...${Colors.RESET}`,
        );
      },
    });

    return host;
  } catch (e) {
    if (e instanceof RuntimeConfigNotFoundError) {
      console.log(`${Colors.RED}❌ Configuration file not found${Colors.RESET}`);
      console.log(`\n${Colors.BRIGHT_YELLOW}📝 Manual Setup:${Colors.RESET}`);
      console.log(`  ${Colors.DIM}mkdir -p ${e.userConfigDir}${Colors.RESET}`);
      console.log(`  ${Colors.DIM}# Place config.yaml in ${e.userConfigDir}${Colors.RESET}`);
      return null;
    }

    if (e instanceof UnsupportedProviderError) {
      console.log(`${Colors.RED}❌ Unsupported provider: ${e.provider}${Colors.RESET}`);
      return null;
    }

    console.log(`${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    return null;
  }
}

const workspaceDir = process.cwd();
fs.mkdirSync(workspaceDir, { recursive: true });

const task = process.argv.slice(2).join(' ').trim();
const host = await createHost(workspaceDir, task ? undefined : null);
if (host) {
  renderRuntimeDiagnostics(host.runtime.diagnostics);

  if (task) {
    await runPrintMode({ host, task });
  } else {
    await runInteractiveMode({
      host,
      setToolConfirmationHandler: (handler) => {
        askToolConfirmation = handler;
      },
    });
  }
}
