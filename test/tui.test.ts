import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntrySelectItems,
  formatTuiToolCall,
  formatTuiToolResult,
  handleIdleCtrlCExit,
  setTuiToolResultsExpanded,
  updateTuiToolResultRecord,
  type CtrlCExitState,
  type TuiToolResultRecord,
} from '../src/modes/tui-mode.js';
import { Input } from '../src/tui/components/input.js';
import { MultilineInput } from '../src/tui/components/multiline-input.js';
import { Text } from '../src/tui/components/text.js';
import { StdinBuffer } from '../src/tui/stdin-buffer.js';
import { TUI } from '../src/tui/tui.js';
import type { ProcessTerminal } from '../src/tui/terminal.js';
import { stripAnsi, visibleWidth, wrapText } from '../src/tui/utils.js';
import { BashTool } from '../src/tools/bash.js';
import type { Tool } from '../src/tools/base.js';
import { EditTool } from '../src/tools/edit.js';
import { FindTool } from '../src/tools/find.js';
import { GrepTool } from '../src/tools/grep.js';
import { LsTool } from '../src/tools/ls.js';
import { ReadTool } from '../src/tools/read.js';
import { WriteTool } from '../src/tools/write.js';

class FakeTerminal {
  writes: string[] = [];
  rawModeEnabled = false;
  cursorVisible = true;
  destroyed = false;
  columns = 40;
  rows = 10;
  private dataListeners: ((data: string) => void)[] = [];
  private resizeListeners: (() => void)[] = [];

  enableRawMode(): void {
    this.rawModeEnabled = true;
  }

  disableRawMode(): void {
    this.rawModeEnabled = false;
  }

  hideCursor(): void {
    this.cursorVisible = false;
  }

  showCursor(): void {
    this.cursorVisible = true;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  getSize(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows };
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      this.dataListeners = this.dataListeners.filter((listener) => listener !== cb);
    };
  }

  onResize(cb: () => void): () => void {
    this.resizeListeners.push(cb);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((listener) => listener !== cb);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitResize(): void {
    for (const listener of this.resizeListeners) listener();
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function asProcessTerminal(terminal: FakeTerminal): ProcessTerminal {
  return terminal as unknown as ProcessTerminal;
}

test('StdinBuffer emits bracketed paste as a single sequence', () => {
  const buffer = new StdinBuffer();
  const events: string[] = [];
  buffer.on('data', (event) => events.push(event));

  buffer.push('a\x1b[200~hello\nworld');
  buffer.push('\x1b[201~b');

  assert.deepEqual(events, ['a', '\x1b[200~hello\nworld\x1b[201~', 'b']);
  buffer.destroy();
});

test('TUI text utilities preserve visible width with ANSI and wide characters', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(visibleWidth('\x1b[31m你a\x1b[0m'), 3);
  assert.deepEqual(wrapText('alpha beta gamma', 10).map(stripAnsi), ['alpha beta', 'gamma']);
});

test('Input handles editing, submit, and history', () => {
  const input = new Input();
  const submitted: string[] = [];
  input.attachTui({ requestRender() {} });
  input.onSubmit((value) => submitted.push(value));

  for (const ch of 'abc') input.handleInput(ch);
  input.handleInput('\x1b[D');
  input.handleInput('\x7f');
  input.handleInput('z');
  input.handleInput('\r');

  assert.deepEqual(submitted, ['azc']);
  input.clear();
  input.handleInput('\x1b[A');
  assert.equal(input.value, 'azc');
});

test('MultilineInput handles bracketed paste, newline, and submit', () => {
  const input = new MultilineInput();
  const submitted: string[] = [];
  input.attachTui({ requestRender() {} });
  input.onSubmit((value) => submitted.push(value));

  input.handleInput('\x1b[200~hello\nworld\x1b[201~');
  input.handleInput('\x1b[13;2u');
  input.handleInput('!');
  input.handleInput('\r');

  assert.equal(submitted[0], 'hello\nworld\n!');
});

test('TUI renders, forwards input to focus, and cleans up', () => {
  const terminal = new FakeTerminal();
  const tui = new TUI(asProcessTerminal(terminal));
  const text = new Text('hello');
  const input = new Input();
  input.attachTui(tui);
  tui.addChild(text);
  tui.addChild(input);
  tui.setFocus(input);

  tui.start();
  tui.requestRender(true);
  assert.equal(terminal.rawModeEnabled, true);
  assert.match(terminal.writes.join(''), /hello/);

  terminal.emitData('x');
  assert.equal(input.value, 'x');

  text.text = 'bye';
  tui.requestRender(true);
  assert.match(terminal.writes.join(''), /bye/);

  tui.stop();
  assert.equal(terminal.rawModeEnabled, false);
  assert.equal(terminal.cursorVisible, true);
  assert.equal(terminal.destroyed, true);
});

test('idle Ctrl-C requires a second press within the exit window', () => {
  const state: CtrlCExitState = { pending: false, lastPressedAt: 0 };

  assert.equal(handleIdleCtrlCExit({ state, now: 1000 }), 'prompt');
  assert.equal(state.pending, true);
  assert.equal(handleIdleCtrlCExit({ state, now: 2500 }), 'exit');
  assert.equal(state.pending, false);

  assert.equal(handleIdleCtrlCExit({ state, now: 5000 }), 'prompt');
  assert.equal(handleIdleCtrlCExit({ state, now: 8001 }), 'prompt');
  assert.equal(state.pending, true);
});

test('TUI entry selector items preserve entry hierarchy and active markers', () => {
  const items = createEntrySelectItems([
    {
      entry: {
        entryId: 'entry-system-abcdef',
        parentEntryId: null,
        type: 'message',
        timestamp: 1,
        isActive: false,
        isActivePath: true,
        messageIndex: 0,
        messageRole: 'system',
        preview: 'system prompt',
      },
      children: [
        {
          entry: {
            entryId: 'entry-user-abcdef',
            parentEntryId: 'entry-system-abcdef',
            type: 'message',
            timestamp: 2,
            isActive: true,
            isActivePath: true,
            messageIndex: 1,
            messageRole: 'user',
            preview: 'selected task',
          },
          children: [],
        },
      ],
    },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0]?.value, 'entry-system-abcdef');
  assert.match(items[0]?.label ?? '', /^\+ entry-system/);
  assert.match(items[0]?.description ?? '', /active path/);
  assert.equal(items[1]?.value, 'entry-user-abcdef');
  assert.match(items[1]?.label ?? '', /^  \* entry-user/);
  assert.match(items[1]?.description ?? '', /selected task/);
});

test('TUI tool calls show pi-style argument summaries', () => {
  assert.equal(stripAnsi(formatTuiToolCall('bash', { command: 'git status', timeout: 3 }, new BashTool())), '$ git status (timeout 3s)');
  assert.equal(stripAnsi(formatTuiToolCall('read', { path: 'src/index.ts', offset: 3, limit: 5 }, new ReadTool())), 'read src/index.ts:3-7');
  assert.equal(
    stripAnsi(formatTuiToolCall('grep', { pattern: 'TODO', path: 'src', max_results: 20, case_sensitive: false }, new GrepTool())),
    'grep /TODO/ in src limit 20 insensitive',
  );
  assert.equal(stripAnsi(formatTuiToolCall('find', { pattern: 'test', path: 'src', max_results: 5 }, new FindTool())), 'find test in src limit 5');
  assert.equal(stripAnsi(formatTuiToolCall('ls', { path: 'docs' }, new LsTool())), 'ls docs');
  assert.equal(stripAnsi(formatTuiToolCall('write', { path: 'out.txt', content: 'hidden' }, new WriteTool())), 'write out.txt');
  assert.equal(stripAnsi(formatTuiToolCall('edit', { path: 'app.ts', old_str: 'a', new_str: 'b' }, new EditTool())), 'edit app.ts');
  assert.equal(stripAnsi(formatTuiToolCall('custom_tool', { path: 'x', limit: 2 })), 'custom_tool(path=x, limit=2)');
});

test('TUI tool result records toggle global expanded rendering', () => {
  const tool: Tool = {
    name: 'sample_tool',
    description: 'Sample',
    parameters: { type: 'object' },
    async execute() {
      return { success: true, content: 'raw' };
    },
    renderResult(result, options) {
      return options.expanded ? `expanded:${result.content}` : `collapsed:${result.content}`;
    },
  };
  const createRecord = (toolCallId: string): TuiToolResultRecord => ({
    text: new Text(''),
    tool,
    result: {
      toolCallId,
      toolName: 'sample_tool',
      success: true,
      content: 'raw',
    },
    args: {},
    expanded: false,
  });
  const first = createRecord('call-1');
  const second = createRecord('call-2');

  assert.match(formatTuiToolResult(first), /collapsed:raw/);
  updateTuiToolResultRecord(first);
  updateTuiToolResultRecord(second);
  assert.match(first.text.text, /collapsed:raw/);
  assert.match(second.text.text, /collapsed:raw/);
  assert.equal(setTuiToolResultsExpanded([first, second], true), true);
  assert.equal(first.expanded, true);
  assert.equal(second.expanded, true);
  assert.match(first.text.text, /expanded:raw/);
  assert.match(second.text.text, /expanded:raw/);
  assert.equal(setTuiToolResultsExpanded([first, second], false), true);
  assert.match(first.text.text, /collapsed:raw/);
  assert.match(second.text.text, /collapsed:raw/);
  assert.equal(setTuiToolResultsExpanded([], true), false);
});

test('TUI tool result records render partial status', () => {
  const tool: Tool = {
    name: 'sample_tool',
    description: 'Sample',
    parameters: { type: 'object' },
    async execute() {
      return { success: true, content: 'raw' };
    },
    renderResult(result, options) {
      return `${options.isPartial ? 'partial' : 'final'}:${result.content}`;
    },
  };
  const record: TuiToolResultRecord = {
    text: new Text(''),
    tool,
    result: {
      toolCallId: 'call-1',
      toolName: 'sample_tool',
      success: true,
      content: 'raw',
    },
    args: {},
    expanded: false,
    isPartial: true,
  };

  assert.match(formatTuiToolResult(record), /sample_tool running/);
  assert.match(formatTuiToolResult(record), /partial:raw/);
  record.isPartial = false;
  assert.match(formatTuiToolResult(record), /sample_tool completed/);
  assert.match(formatTuiToolResult(record), /final:raw/);
});
