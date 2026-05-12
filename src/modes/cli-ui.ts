import { type AgentSessionEvent } from '../schema.js';
import type { RuntimeDiagnostic, ToolConfirmationRequest, ToolPermissionDecision } from '../core/runtime.js';
import { Colors, calculateDisplayWidth } from '../utils/terminal.js';

const BOX_WIDTH = 58;

type RenderState = {
  printedThinkingHeader: boolean;
  printedAssistantHeader: boolean;
};

export type CliPrompt = (question: string) => Promise<string>;

export function createCliRenderer() {
  let state: RenderState = {
    printedThinkingHeader: false,
    printedAssistantHeader: false,
  };

  return (event: AgentSessionEvent): void => {
    if (event.type === 'message_start') {
      state = { printedThinkingHeader: false, printedAssistantHeader: false };
      const stepLabel = event.maxSteps ? `Step ${event.step}/${event.maxSteps}` : `Step ${event.step}`;
      const stepText = `${Colors.BOLD}${Colors.BRIGHT_CYAN}💭 ${stepLabel}${Colors.RESET}`;
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
      for (const [key, value] of Object.entries(event.tool_call.function.arguments)) {
        const text = String(value);
        truncated[key] = text.length > 200 ? text.slice(0, 200) + '...' : value;
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

    if (event.type === 'usage') return;

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

export interface RenderRuntimeDiagnosticsOptions {
  verbose?: boolean;
}

const DEFAULT_VISIBLE_INFO_CODES = new Set(['retry_enabled', 'system_prompt_loaded']);

export function formatRuntimeDiagnostic(diagnostic: RuntimeDiagnostic): string {
  return `[${diagnostic.level}] ${diagnostic.source}:${diagnostic.code} ${diagnostic.message}`;
}

export function renderRuntimeDiagnostics(
  diagnostics: RuntimeDiagnostic[],
  options: RenderRuntimeDiagnosticsOptions = {},
): void {
  const verbose = options.verbose === true;
  for (const diagnostic of diagnostics) {
    if (!verbose && diagnostic.level === 'info' && !DEFAULT_VISIBLE_INFO_CODES.has(diagnostic.code)) {
      continue;
    }

    if (diagnostic.code === 'retry_enabled' || diagnostic.code === 'system_prompt_loaded') {
      console.log(`${Colors.GREEN}✅ ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    if (diagnostic.level === 'error') {
      console.log(`${Colors.RED}❌ ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    if (diagnostic.type === 'warning') {
      console.log(`${Colors.YELLOW}⚠️  ${diagnostic.message}${Colors.RESET}`);
      continue;
    }

    console.log(`${Colors.DIM}${diagnostic.message}${Colors.RESET}`);
  }
}

export function createToolConfirmationPrompt(prompt: CliPrompt) {
  return async ({ tool, args, metadata }: ToolConfirmationRequest): Promise<ToolPermissionDecision> => {
    console.log();
    console.log(
      Colors.BRIGHT_YELLOW +
        '⚠️  Tool requires confirmation:' +
        Colors.RESET +
        ' ' +
        Colors.BOLD +
        Colors.CYAN +
        tool.name +
        Colors.RESET,
    );
    console.log(
      Colors.DIM +
        '   category=' +
        metadata.category +
        ' risk=' +
        metadata.riskLevel +
        ' readOnly=' +
        metadata.isReadOnly +
        Colors.RESET,
    );
    console.log(Colors.DIM + '   Arguments:' + Colors.RESET);

    const truncated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const text = String(value);
      truncated[key] = text.length > 300 ? text.slice(0, 300) + '...' : value;
    }
    for (const line of JSON.stringify(truncated, null, 2).split('\n')) {
      console.log('   ' + Colors.DIM + line + Colors.RESET);
    }

    const answer = (await prompt(Colors.BRIGHT_YELLOW + 'Allow this tool call? [y/N] ' + Colors.RESET))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes' ? 'allow' : 'deny';
  };
}
