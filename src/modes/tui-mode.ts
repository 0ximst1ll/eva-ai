import type { RuntimeHost } from '../core/runtime-host.js';
import type { AgentSessionEvent } from '../schema.js';
import type { ToolConfirmationRequest, ToolPermissionDecision } from '../core/runtime.js';
import { TUI } from '../tui/tui.js';
import { ProcessTerminal } from '../tui/terminal.js';
import { Container } from '../tui/component.js';
import { Text, Separator, Spacer } from '../tui/components/text.js';
import { Input } from '../tui/components/input.js';
import { MultilineInput } from '../tui/components/multiline-input.js';
import { Footer } from '../tui/components/footer.js';
import { Spinner } from '../tui/components/spinner.js';
import { Markdown } from '../tui/components/markdown.js';
import { SelectList } from '../tui/components/select-list.js';
import { matchesKey } from '../tui/keys.js';
import { Colors } from '../utils/terminal.js';
import { handleInteractiveCommand } from './interactive-mode.js';

export interface TuiModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) => void;
}

export interface CtrlCExitState {
  pending: boolean;
  lastPressedAt: number;
}

export type CtrlCExitAction = 'prompt' | 'exit';

const CTRL_C_EXIT_WINDOW_MS = 2000;

export function handleIdleCtrlCExit({
  state,
  now = Date.now(),
  windowMs = CTRL_C_EXIT_WINDOW_MS,
}: {
  state: CtrlCExitState;
  now?: number;
  windowMs?: number;
}): CtrlCExitAction {
  if (state.pending && now - state.lastPressedAt <= windowMs) {
    state.pending = false;
    state.lastPressedAt = now;
    return 'exit';
  }
  state.pending = true;
  state.lastPressedAt = now;
  return 'prompt';
}

// ── Helpers ────────────────────────────────────────────────

function toolIcon(toolName: string): string {
  if (toolName.startsWith('read') || toolName === 'list_files') return '📄';
  if (toolName.startsWith('write') || toolName.startsWith('edit')) return '✏️ ';
  if (toolName === 'bash' || toolName === 'bash_output' || toolName === 'bash_kill') return '⚡';
  if (toolName.startsWith('find') || toolName.startsWith('grep')) return '🔍';
  return '🔧';
}

function formatArg(key: string, value: unknown): string {
  const s = String(value);
  const truncated = s.length > 80 ? s.slice(0, 80) + '…' : s;
  return `  ${Colors.DIM}${key}:${Colors.RESET} ${truncated}`;
}

// ── Main ──────────────────────────────────────────────────

export async function runTuiMode({ host, setToolConfirmationHandler }: TuiModeOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // ── Layout ────────────────────────────────────────────────
  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const inputContainer = new Container();
  const footer = new Footer();

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(statusContainer);
  tui.addChild(inputContainer);
  tui.addChild(footer);

  // ── Header ───────────────────────────────────────────────
  const cfg = host.runtime.config;
  headerContainer.addChild(new Spacer());
  headerContainer.addChild(
    new Text(
      `${Colors.BOLD}${Colors.BRIGHT_CYAN}Eva AI${Colors.RESET}  ` +
      `${Colors.DIM}${cfg.llm.provider} / ${cfg.llm.model}${Colors.RESET}`,
      { wrap: false },
    ),
  );
  headerContainer.addChild(
    new Text(
      `${Colors.DIM}Enter to send · Shift+Enter for newline · /help for commands · Ctrl-C to cancel/exit${Colors.RESET}`,
      { wrap: false },
    ),
  );
  headerContainer.addChild(new Separator());

  // ── Input ────────────────────────────────────────────────
  const input = new MultilineInput(
    'Type a message or /command…',
    `${Colors.BRIGHT_GREEN}You${Colors.RESET} › `,
    `${Colors.DIM}    ${Colors.RESET}`,
  );
  input.attachTui(tui);
  inputContainer.addChild(new Separator());
  inputContainer.addChild(input);

  // ── Footer ───────────────────────────────────────────────
  footer.update({
    model: cfg.llm.model,
    provider: cfg.llm.provider,
    tokens: 0,
    sessionId: host.sessionId,
    status: 'idle',
  });

  // ── Tool confirmation handler ─────────────────────────────
  setToolConfirmationHandler(async ({ tool, args }: ToolConfirmationRequest): Promise<ToolPermissionDecision> => {
    return new Promise((resolve) => {
      chatContainer.addChild(new Spacer());
      chatContainer.addChild(
        new Text(
          `${Colors.BRIGHT_YELLOW}⚠  Tool requires confirmation:${Colors.RESET} ` +
          `${Colors.BOLD}${Colors.CYAN}${toolIcon(tool.name)} ${tool.name}${Colors.RESET}`,
          { wrap: false },
        ),
      );
      for (const [k, v] of Object.entries(args)) {
        chatContainer.addChild(new Text(formatArg(k, v), { wrap: false }));
      }
      tui.requestRender();

      const confirmInput = new Input('', `${Colors.BRIGHT_YELLOW}Allow? [y/N]${Colors.RESET} › `);
      confirmInput.attachTui(tui);
      inputContainer.clear();
      inputContainer.addChild(new Separator());
      inputContainer.addChild(confirmInput);
      tui.setFocus(confirmInput);

      confirmInput.onSubmit((val) => {
        const allowed = val.trim().toLowerCase() === 'y' || val.trim().toLowerCase() === 'yes';
        chatContainer.addChild(
          new Text(
            allowed
              ? `${Colors.GREEN}✓ Allowed${Colors.RESET}`
              : `${Colors.DIM}✗ Denied${Colors.RESET}`,
            { wrap: false },
          ),
        );
        inputContainer.clear();
        inputContainer.addChild(new Separator());
        inputContainer.addChild(input);
        tui.setFocus(input);
        tui.requestRender();
        resolve(allowed ? 'allow' : 'deny');
      });
    });
  });

  // ── Event renderer ────────────────────────────────────────
  let streamingContent: Markdown | null = null;
  let abortController: AbortController | null = null;
  let stopped = false;
  const ctrlCExitState: CtrlCExitState = { pending: false, lastPressedAt: 0 };
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stopTui = (): void => {
    if (stopped) return;
    stopped = true;
    tui.stop();
    resolveStopped?.();
  };

  const handleEvent = (event: AgentSessionEvent): void => {
    switch (event.type) {

      case 'message_start': {
        chatContainer.addChild(new Spacer());
        streamingContent = null;
        tui.requestRender();
        break;
      }

      case 'thinking_delta': {
        break;
      }

      case 'content_delta': {
        if (!streamingContent) {
          chatContainer.addChild(
            new Text(`${Colors.BOLD}${Colors.BRIGHT_BLUE}Assistant${Colors.RESET}`, { wrap: false }),
          );
          streamingContent = new Markdown('');
          chatContainer.addChild(streamingContent);
        }
        streamingContent.append(event.text);
        tui.requestRender();
        break;
      }

      case 'tool_call': {
        const name = event.tool_call.function.name;
        const icon = toolIcon(name);
        chatContainer.addChild(
          new Text(
            `${Colors.BRIGHT_YELLOW}${icon} ${Colors.BOLD}${name}${Colors.RESET}`,
            { wrap: false },
          ),
        );
        tui.requestRender();
        break;
      }

      case 'tool_result': {
        const r = event.result;
        if (r.success) {
          chatContainer.addChild(
            new Text(
              `${Colors.BRIGHT_GREEN}✓${Colors.RESET} ${Colors.DIM}${r.toolName} completed${Colors.RESET}`,
              { wrap: false },
            ),
          );
        } else {
          chatContainer.addChild(
            new Text(
              `${Colors.BRIGHT_RED}✗ ${r.error ?? r.content}${Colors.RESET}`,
              { wrap: true },
            ),
          );
        }
        tui.requestRender();
        break;
      }

      case 'message_end': {
        streamingContent = null;
        const elapsed = (event.elapsedMs / 1000).toFixed(1);
        chatContainer.addChild(
          new Text(`${Colors.DIM}⏱ ${elapsed}s${Colors.RESET}`, { wrap: false }),
        );
        const usage = host.session.usage;
        footer.update({ tokens: usage.total.total_tokens, status: 'idle' });
        tui.requestRender();
        break;
      }

      case 'error': {
        chatContainer.addChild(
          new Text(`${Colors.BRIGHT_RED}✗ Error: ${event.message}${Colors.RESET}`, { wrap: true }),
        );
        footer.update({ status: 'idle' });
        tui.requestRender();
        break;
      }

      case 'usage':
        break;
    }
  };

  // ── Running state (Spinner) ───────────────────────────────
  const spinner = new Spinner('');
  spinner.attachTui(tui);

  const setRunning = (running: boolean, label = ''): void => {
    if (running) {
      spinner.label = label || 'Working…  Ctrl-C to cancel';
      if (!statusContainer.children.includes(spinner)) {
        statusContainer.addChild(spinner);
      }
      spinner.start();
      footer.update({ status: 'running' });
    } else {
      spinner.stop();
      statusContainer.removeChild(spinner);
      footer.update({ status: 'idle' });
    }
    tui.requestRender();
  };

  // ── Slash command output formatter ───────────────────────
  // Wraps writeLine to strip leading/trailing empty calls and preserve color
  const commandWriteLine = (msg = ''): void => {
    chatContainer.addChild(new Text(msg, { wrap: true }));
    tui.requestRender();
  };

  // ── Session selector (shown for /sessions command) ────────
  const showSessionSelector = async (): Promise<void> => {
    const sessions = await host.runtime.sessionManager.listSessions();
    if (!sessions.length) {
      chatContainer.addChild(new Text(`${Colors.DIM}No sessions found.${Colors.RESET}`, { wrap: false }));
      tui.requestRender();
      return;
    }

    const items = sessions.map((s) => ({
      value: s.sessionId,
      label: s.sessionId.slice(0, 12),
      description: `${s.messageCount} msgs · ${s.isLatest ? 'latest · ' : ''}${new Date(s.updatedAt).toLocaleString()}`,
    }));

    const selector = new SelectList(items, Math.min(8, sessions.length));
    selector.attachTui(tui);

    chatContainer.addChild(new Text(`${Colors.BRIGHT_CYAN}Select session:${Colors.RESET}`, { wrap: false }));
    chatContainer.addChild(selector);
    tui.setFocus(selector);
    tui.requestRender();

    await new Promise<void>((resolve) => {
      selector.onSelect = async (item) => {
        chatContainer.removeChild(selector);
        await host.switchSession(item.value);
        footer.update({ sessionId: host.sessionId });
        chatContainer.addChild(new Text(
          `${Colors.GREEN}✓ Switched to session ${item.value.slice(0, 12)}${Colors.RESET}`,
          { wrap: false },
        ));
        tui.setFocus(input);
        tui.requestRender();
        resolve();
      };
      selector.onCancel = () => {
        chatContainer.removeChild(selector);
        tui.setFocus(input);
        tui.requestRender();
        resolve();
      };
    });
  };

  // ── Submit handler ────────────────────────────────────────
  input.onSubmit(async (rawValue) => {
    const userInput = rawValue.trim();
    input.clear();
    if (!userInput) return;

    // Intercept /sessions for interactive TUI selector
    if (userInput === '/sessions') {
      await showSessionSelector();
      return;
    }

    const commandResult = await handleInteractiveCommand({
      userInput,
      host,
      writeLine: commandWriteLine,
    });

    if (commandResult === 'exit') {
      stopTui();
      return;
    }

    if (commandResult === 'continue') {
      ctrlCExitState.pending = false;
      footer.update({
        model: host.runtime.config.llm.model,
        provider: host.runtime.config.llm.provider,
        sessionId: host.sessionId,
      });
      tui.requestRender();
      return;
    }

    // Plain message
    ctrlCExitState.pending = false;
    chatContainer.addChild(new Spacer());
    chatContainer.addChild(
      new Text(
        `${Colors.BRIGHT_GREEN}You${Colors.RESET}  ${userInput.replace(/\n/g, '\n    ')}`,
        { wrap: true },
      ),
    );

    await host.session.addUserMessage(userInput);
    abortController = new AbortController();
    setRunning(true);

    try {
      await host.session.run({
        signal: abortController.signal,
        onEvent: handleEvent,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        chatContainer.addChild(
          new Text(`${Colors.BRIGHT_YELLOW}⚠ Cancelled${Colors.RESET}`, { wrap: false }),
        );
      } else {
        chatContainer.addChild(
          new Text(`${Colors.BRIGHT_RED}✗ Error: ${e}${Colors.RESET}`, { wrap: true }),
        );
      }
    } finally {
      abortController = null;
      setRunning(false);
    }
  });

  // ── Global key handler (Ctrl-C / Ctrl-D) ─────────────────
  terminal.onData((data: string) => {
    if (matchesKey(data, 'ctrl-c')) {
      if (abortController) {
        ctrlCExitState.pending = false;
        abortController.abort();
      } else {
        const action = handleIdleCtrlCExit({ state: ctrlCExitState });
        if (action === 'exit') {
          chatContainer.addChild(
            new Text(`${Colors.DIM}Goodbye!${Colors.RESET}`, { wrap: false }),
          );
          tui.requestRender(true);
          setTimeout(stopTui, 80);
        } else {
          chatContainer.addChild(
            new Text(`${Colors.DIM}Press Ctrl-C again to exit.${Colors.RESET}`, { wrap: false }),
          );
          tui.requestRender();
        }
      }
      return;
    }
    if (matchesKey(data, 'ctrl-d')) {
      if (!abortController && input.value.trim().length === 0) {
        stopTui();
      }
    }
  });

  // ── Start ─────────────────────────────────────────────────
  tui.setFocus(input);
  tui.start();

  await stoppedPromise;
}
