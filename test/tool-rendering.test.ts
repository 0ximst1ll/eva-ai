import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolDefinition,
  formatToolResultDisplay,
  renderToolResult,
  toolFromDefinition,
  type Tool,
} from '../src/tools/base.js';
import { BashTool } from '../src/tools/bash.js';

const metadata = {
  category: 'read',
  riskLevel: 'low',
  source: 'builtin',
  isReadOnly: true,
  isConcurrencySafe: true,
} as const;

test('tool definitions preserve result renderers', () => {
  const tool: Tool = {
    name: 'sample',
    description: 'Sample tool',
    parameters: { type: 'object' },
    async execute() {
      return { success: true, content: 'raw', details: { count: 2 } };
    },
    renderResult(result) {
      return `count=${result.details?.['count']}`;
    },
  };

  const definition = createToolDefinition(tool, metadata);
  const wrapped = toolFromDefinition(definition);
  const display = renderToolResult(
    wrapped,
    { success: true, content: 'raw', details: { count: 2 } },
    {
      toolCallId: 'call-1',
      args: {},
    },
  );

  assert.equal(display, 'count=2');
});

test('formatToolResultDisplay keeps a bounded output preview', () => {
  const display = formatToolResultDisplay(
    'exit=0; stdout=2000 chars',
    { content: 'a'.repeat(10) + '\n' + 'b'.repeat(2000) },
    { maxPreviewChars: 20 },
  );

  assert.match(display, /exit=0/);
  assert.match(display, /aaaaaaaaaa/);
  assert.match(display, /preview truncated/);
  assert.ok(display.length < 120);
});

test('formatToolResultDisplay supports collapsed line previews', () => {
  const display = formatToolResultDisplay(
    '5 matches',
    { content: ['one', 'two', 'three', 'four'].join('\n') },
    { maxPreviewLines: 2 },
  );

  assert.match(display, /one\ntwo/);
  assert.doesNotMatch(display, /three/);
  assert.match(display, /2 more lines/);
});

test('formatToolResultDisplay shows all returned text when expanded', () => {
  const display = formatToolResultDisplay(
    '5 matches',
    { content: ['one', 'two', 'three', 'four'].join('\n') },
    { maxPreviewLines: 2, maxPreviewChars: 5, expanded: true },
  );

  assert.match(display, /one\ntwo\nthree\nfour/);
  assert.doesNotMatch(display, /more lines/);
  assert.doesNotMatch(display, /preview truncated/);
});

test('formatToolResultDisplay supports tail previews for bash-style output', () => {
  const display = formatToolResultDisplay(
    'exit=0',
    { content: ['one', 'two', 'three', 'four'].join('\n') },
    { maxPreviewLines: 2, previewMode: 'tail' },
  );

  assert.match(display, /2 earlier lines/);
  assert.doesNotMatch(display, /one/);
  assert.match(display, /three\nfour/);
});

test('formatToolResultDisplay supports tail previews by visual line width', () => {
  const display = formatToolResultDisplay(
    'exit=0',
    { content: 'abcdefghijklmnopqrstuvwxyz' },
    {
      maxPreviewLines: 2,
      maxPreviewChars: 200,
      previewMode: 'tail',
      previewLineMode: 'visual',
      previewWidth: 10,
      moreLabel: 'earlier visual lines',
    },
  );

  assert.match(display, /1 earlier visual lines/);
  assert.doesNotMatch(display, /abcdefghij/);
  assert.match(display, /klmnopqrst\nuvwxyz/);
});

test('bash renderer uses terminal width for collapsed visual-line tails', () => {
  const tool = new BashTool('/workspace');
  const display = renderToolResult(
    tool,
    {
      success: true,
      content: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      details: {
        exitCode: 0,
        stdoutChars: 62,
        stderrChars: 0,
      },
    },
    {
      toolCallId: 'call-1',
      args: { command: 'echo hello' },
    },
    {
      terminalColumns: 10,
    },
  );

  assert.match(display ?? '', /2 earlier visual lines/);
  assert.doesNotMatch(display ?? '', /abcdefghij/);
  assert.match(display ?? '', /uvwxyzABCD\nEFGHIJKLMN\nOPQRSTUVWX\nYZ01234567\n89/);
});
