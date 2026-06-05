import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderToolExecutionResult,
  renderToolMessageForExportText,
  renderToolMessageResult,
} from '../src/core/tool-result-renderer.js';
import type { Message } from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

const sampleTool: Tool = {
  name: 'sample',
  description: 'Sample tool',
  parameters: { type: 'object' },
  async execute() {
    return { success: true, content: 'raw' };
  },
  renderResult(result, options, context) {
    return [
      context.args['path'],
      options.expanded ? 'expanded' : 'collapsed',
      result.details?.['count'],
      result.content,
    ].join(':');
  },
};

test('renderToolExecutionResult renders runtime results through tool definitions', () => {
  const text = renderToolExecutionResult({
    tool: sampleTool,
    args: { path: 'file.txt' },
    result: {
      toolCallId: 'call-1',
      toolName: 'sample',
      success: true,
      content: 'raw',
      details: { count: 2 },
    },
  });

  assert.equal(text, 'file.txt:collapsed:2:raw');
});

test('renderToolMessageResult renders durable tool messages through the same renderer', () => {
  const message: Extract<Message, { role: 'tool' }> = {
    role: 'tool',
    content: 'raw',
    tool_call_id: 'call-1',
    name: 'sample',
    details: { count: 2 },
  };

  const text = renderToolMessageResult({
    tool: sampleTool,
    message,
    args: { path: 'file.txt' },
  });

  assert.equal(text, 'file.txt:collapsed:2:raw');
});

test('renderToolMessageForExportText expands historical tool output by default', () => {
  const message: Extract<Message, { role: 'tool' }> = {
    role: 'tool',
    content: 'raw',
    tool_call_id: 'call-1',
    name: 'sample',
    details: { count: 2 },
  };

  const text = renderToolMessageForExportText({
    tool: sampleTool,
    message,
    args: { path: 'file.txt' },
  });

  assert.equal(text, 'file.txt:expanded:2:raw');
});

test('tool result renderer falls back to flattened content blocks without a tool definition', () => {
  const text = renderToolExecutionResult({
    result: {
      toolCallId: 'call-1',
      toolName: 'blocks',
      success: true,
      content: 'fallback',
      contentBlocks: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
  });

  assert.equal(text, 'first\nsecond');
});

test('tool result renderer preserves error text for durable error messages', () => {
  const message: Extract<Message, { role: 'tool' }> = {
    role: 'tool',
    content: 'Error: denied',
    tool_call_id: 'call-1',
    name: 'sample',
  };

  assert.equal(renderToolMessageResult({ message }), 'denied');
});
