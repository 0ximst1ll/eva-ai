import type { RuntimeHost } from '../core/runtime-host.js';
import type { ToolConfirmationRequest } from '../core/runtime.js';
import type { AgentSessionEvent } from '../schema.js';
import { ProcessTerminal } from '../tui/terminal.js';
import { TUI, Container } from '../tui/tui.js';
import { Text } from '../tui/components/text.js';
import { Editor } from '../tui/components/editor.js';
import { AssistantMessage } from '../tui/components/assistant-message.js';
import { ToolExecution } from '../tui/components/tool-execution.js';
import { ConfirmationDialog } from '../tui/components/confirmation-dialog.js';
import { Header } from '../tui/components/header.js';
import { Footer } from '../tui/components/footer.js';
import { Colors } from '../utils/terminal.js';
import { handleInteractiveCommand } from './interactive-mode.js';

export interface TuiModeOptions {
  host: RuntimeHost;
  setToolConfirmationHandler: (handler: (request: ToolConfirmationRequest) => Promise<boolean>) => void;
}

export async function runTuiMode({ host, setToolConfirmationHandler }: TuiModeOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // Layout
  const header = new Header('Eva AI - TUI Mode');
  
  const messageLog = new Container();
  const footer = new Footer();
  footer.setStatus({
    model: host.runtime.config.llm.model,
    session: host.sessionId,
    tokens: host.session.usage.total.total_tokens,
  });

  const addMessage = (text: string) => {
    messageLog.addChild(new Text({ content: text }));
    tui.requestRender();
  };

  let abortController: AbortController | null = null;
  let activeAssistantMessage: AssistantMessage | null = null;
  const activeTools = new Map<string, ToolExecution>();

  const renderEvent = (event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_start':
        footer.setStatus({ step: event.step, maxSteps: event.maxSteps });
        activeAssistantMessage = new AssistantMessage({
          onUpdate: () => tui.requestRender()
        });
        messageLog.addChild(activeAssistantMessage);
        tui.requestRender();
        break;
      case 'thinking_delta':
        if (activeAssistantMessage) {
          activeAssistantMessage.addThinkingDelta(event.text);
          tui.requestRender();
        }
        break;
      case 'content_delta':
        if (activeAssistantMessage) {
          activeAssistantMessage.addContentDelta(event.text);
          tui.requestRender();
        }
        break;
      case 'tool_call': {
        const execution = new ToolExecution({
          toolName: event.tool_call.function.name,
          args: event.tool_call.function.arguments,
          onUpdate: () => tui.requestRender()
        });
        activeTools.set(event.tool_call.id, execution);
        messageLog.addChild(execution);
        tui.requestRender();
        break;
      }
      case 'tool_result': {
        const execution = activeTools.get(event.result.toolCallId);
        if (execution) {
          execution.finish(event.result.success, event.result.error || event.result.content);
          activeTools.delete(event.result.toolCallId);
          tui.requestRender();
        }
        break;
      }
      case 'usage':
        footer.setStatus({ tokens: event.usage.total_tokens });
        tui.requestRender();
        break;
      case 'error':
        if (activeAssistantMessage) {
          activeAssistantMessage.finish(0);
          activeAssistantMessage = null;
        }
        addMessage(`${Colors.BRIGHT_RED}❌ Error:${Colors.RESET} ${event.message}`);
        break;
      case 'message_end':
        if (activeAssistantMessage) {
          activeAssistantMessage.finish(event.elapsedMs);
          activeAssistantMessage = null;
          tui.requestRender();
        }
        break;
    }
  };

  setToolConfirmationHandler((request) => {
    return new Promise((resolve) => {
      const dialog = new ConfirmationDialog({
        toolName: request.toolCall.function.name,
        category: '', // Removed from schema
        riskLevel: request.metadata?.riskLevel || 'medium',
        args: request.toolCall.function.arguments,
        onUpdate: () => tui.requestRender(),
        onResolve: (approved) => {
          tui.removeChild(dialog);
          tui.setFocus(editor);
          tui.requestRender();
          resolve(approved);
        }
      });
      tui.addChild(dialog);
      tui.setFocus(dialog);
      tui.requestRender();
    });
  });

  const COMMANDS = ['/exit', '/compact', '/help', '/stats', '/diagnostics', '/clear'];

  const editor = new Editor({
    onAutocomplete: (text: string) => {
      if (!text.startsWith('/')) return undefined;
      const match = COMMANDS.find(cmd => cmd.startsWith(text));
      if (match) {
        return match.slice(text.length); // return the missing part
      }
      return undefined;
    },
    onSubmit: async (text) => {
      // Echo user message
      addMessage(`${Colors.BRIGHT_GREEN}You${Colors.RESET} › ${text}`);

      // Handle slash commands
      const commandResult = await handleInteractiveCommand({
        userInput: text,
        host,
        writeLine: (msg = '') => addMessage(msg),
      });

      if (commandResult === 'exit') {
        tui.stop();
        process.exit(0);
      }
      if (commandResult === 'continue') {
        return;
      }

      // Run agent
      await host.session.addUserMessage(text);
      abortController = new AbortController();

      try {
        await host.session.run({
          signal: abortController.signal,
          onEvent: renderEvent,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          addMessage(`${Colors.BRIGHT_YELLOW}⚠️  Agent execution cancelled${Colors.RESET}`);
        } else {
          addMessage(`${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
        }
      } finally {
        abortController = null;
      }
    },
  });

  tui.addChild(header);
  tui.addChild(messageLog);
  tui.addChild(editor);
  tui.addChild(footer);

  // Route input to editor
  tui.setFocus(editor);

  // Add initial greeting
  addMessage(`${Colors.DIM}Welcome to Eva AI TUI. Type /exit to quit.${Colors.RESET}`);

  // Start TUI
  tui.start();
}
