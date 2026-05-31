import { type AgentSessionEvent } from '../schema.js';
import type { RuntimeDiagnostic, ToolConfirmationRequest, ToolPermissionDecision } from '../core/runtime.js';
import { renderToolResult, type Tool } from '../tools/base.js';
import { Colors, calculateDisplayWidth } from '../utils/terminal.js';

const BOX_WIDTH = 58;
const TOOL_RESULT_PREVIEW_MAX_CHARS = 4000;

type RenderState = {
  printedThinkingHeader: boolean;
  printedAssistantHeader: boolean;
  working: boolean;
  toolArgs: Map<string, Record<string, unknown>>;
};

export type CliPrompt = (question: string) => Promise<string>;

export interface CliRendererOptions {
  tools?: Tool[];
}

export function createCliRenderer(options: CliRendererOptions = {}) {
  const toolMap = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  let state: RenderState = {
    printedThinkingHeader: false,
    printedAssistantHeader: false,
    working: false,
    toolArgs: new Map(),
  };

  return (event: AgentSessionEvent): void => {
    if (event.type === 'agent_start') {
      if (!state.working) {
        state.working = true;
        console.log(`\n${Colors.DIM}Working...${Colors.RESET}`);
      }
      return;
    }

    if (event.type === 'agent_end') {
      state.working = false;
      return;
    }

    if (event.type === 'message_start') {
      state = { ...state, printedThinkingHeader: false, printedAssistantHeader: false };
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
      state.toolArgs.set(event.tool_call.id, event.tool_call.function.arguments);
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
        const tool = toolMap.get(event.result.toolName);
        let text = tool
          ? renderToolResult(
              tool,
              event.result,
              {
                toolCallId: event.result.toolCallId,
                args: event.result.args ?? state.toolArgs.get(event.result.toolCallId) ?? {},
              },
              { expanded: false, isPartial: false },
            ) ?? event.result.displayContent ?? event.result.content
          : event.result.displayContent ?? event.result.content;
        if (text.length > TOOL_RESULT_PREVIEW_MAX_CHARS) {
          text = text.slice(0, TOOL_RESULT_PREVIEW_MAX_CHARS) + `${Colors.DIM}...${Colors.RESET}`;
        }
        console.log(`${Colors.BRIGHT_GREEN}✓ Result:${Colors.RESET} ${text}`);
      } else {
        const text = event.result.displayContent ?? event.result.error ?? event.result.content;
        console.log(
          `${Colors.BRIGHT_RED}✗ Error:${Colors.RESET} ${Colors.RED}${text}${Colors.RESET}`,
        );
      }
      state.toolArgs.delete(event.result.toolCallId);
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
