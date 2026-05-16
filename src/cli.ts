import * as fs from 'node:fs';
import {
  RuntimeConfigNotFoundError,
  UnsupportedProviderError,
  type ToolPermissionDecision,
  type ToolConfirmationRequest,
} from './core/runtime.js';
import { RuntimeHost } from './core/runtime-host.js';
import { renderRuntimeDiagnostics, runInteractiveMode, runPrintMode, runRpcMode, runTuiMode } from './modes/index.js';
import { Colors } from './utils/terminal.js';

let askToolConfirmation: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined;

interface CreateHostOptions {
  quiet?: boolean;
}

async function createHost(
  workspaceDir: string,
  maxSteps?: number | null,
  options: CreateHostOptions = {},
): Promise<RuntimeHost | null> {
  const log = options.quiet ? console.error : console.log;

  try {
    const host = await RuntimeHost.create({
      workspaceDir,
      maxSteps,
      confirmToolCall: (request) => askToolConfirmation?.(request) ?? 'ask',
      onLlmRetry: options.quiet ? undefined : ({ error, attempt, nextDelay }) => {
        log(`\n${Colors.BRIGHT_YELLOW}⚠️  LLM call failed (attempt ${attempt}): ${error.message}${Colors.RESET}`);
        log(
          `${Colors.DIM}   Retrying in ${nextDelay.toFixed(1)}s (attempt ${attempt + 1})...${Colors.RESET}`,
        );
      },
    });

    return host;
  } catch (e) {
    if (e instanceof RuntimeConfigNotFoundError) {
      log(`${Colors.RED}❌ Configuration file not found${Colors.RESET}`);
      log(`\n${Colors.BRIGHT_YELLOW}📝 Manual Setup:${Colors.RESET}`);
      log(`  ${Colors.DIM}mkdir -p ${e.userConfigDir}${Colors.RESET}`);
      log(`  ${Colors.DIM}# Place config.yaml in ${e.userConfigDir}${Colors.RESET}`);
      return null;
    }

    if (e instanceof UnsupportedProviderError) {
      log(`${Colors.RED}❌ Unsupported provider: ${e.provider}${Colors.RESET}`);
      return null;
    }

    log(`${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
    return null;
  }
}

const workspaceDir = process.cwd();
fs.mkdirSync(workspaceDir, { recursive: true });

const args = process.argv.slice(2);
const noTuiFlag = args.includes('--no-tui');
const rpcFlag = args.includes('--rpc');
const remainingArgs = args.filter((a) => a !== '--no-tui' && a !== '--rpc');
const task = remainingArgs.join(' ').trim();
const canUseTui = process.stdin.isTTY && process.stdout.isTTY;

const host = await createHost(workspaceDir, task || rpcFlag ? undefined : null, { quiet: rpcFlag });
if (host) {
  if (!rpcFlag) renderRuntimeDiagnostics(host.runtime.diagnostics);

  if (rpcFlag) {
    await runRpcMode({
      host,
      setToolConfirmationHandler: (handler) => {
        askToolConfirmation = handler;
      },
    });
  } else if (task) {
    await runPrintMode({ host, task });
  } else if (noTuiFlag || !canUseTui) {
    await runInteractiveMode({
      host,
      setToolConfirmationHandler: (handler) => {
        askToolConfirmation = handler;
      },
    });
  } else {
    await runTuiMode({
      host,
      setToolConfirmationHandler: (handler) => {
        askToolConfirmation = handler;
      },
    });
  }
}
