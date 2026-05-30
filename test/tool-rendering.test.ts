import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolDefinition,
  renderToolResult,
  toolFromDefinition,
  type Tool,
} from '../src/tools/base.js';

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
