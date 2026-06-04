import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompactionMessages,
  prepareCompactionInput,
} from '../src/core/compaction.js';
import type { Message } from '../src/schema.js';

function assistantWithToolCalls(): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-read',
        type: 'function',
        function: {
          name: 'read',
          arguments: { path: 'src/index.ts' },
        },
      },
      {
        id: 'call-write',
        type: 'function',
        function: {
          name: 'write',
          arguments: { path: 'src/output.ts' },
        },
      },
      {
        id: 'call-edit',
        type: 'function',
        function: {
          name: 'edit',
          arguments: { path: 'src/output.ts' },
        },
      },
    ],
  };
}

test('prepareCompactionInput normalizes old tool results and tracks file operations', () => {
  const largeReadOutput = Array.from({ length: 500 }, (_, index) => `${index + 1}|${'x'.repeat(80)}`).join('\n');
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'inspect files' },
    assistantWithToolCalls(),
    {
      role: 'tool',
      tool_call_id: 'call-read',
      name: 'read',
      content: largeReadOutput,
    },
    {
      role: 'tool',
      tool_call_id: 'call-write',
      name: 'write',
      content: 'Wrote src/output.ts',
    },
    { role: 'user', content: 'recent task' },
    { role: 'assistant', content: 'recent answer' },
  ];

  const prepared = prepareCompactionInput({ messages, keepRecentMessages: 2 });
  const normalizedToolMessage = prepared.messages.find((message) => message.role === 'tool' && message.name === 'read');

  assert.equal(prepared.firstKeptMessageIndex, 5);
  assert.deepEqual(prepared.fileOperations, {
    readFiles: ['src/index.ts'],
    modifiedFiles: ['src/output.ts'],
  });
  assert.ok(normalizedToolMessage);
  assert.ok(normalizedToolMessage.content.length < largeReadOutput.length);
  assert.match(normalizedToolMessage.content, /Tool result normalized for compaction/);
});

test('buildCompactionMessages includes tracked file operations outside transcript', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
  ];

  const compactionMessages = buildCompactionMessages({
    messages,
    fileOperations: {
      readFiles: ['src/index.ts'],
      modifiedFiles: ['src/output.ts'],
    },
  });

  const prompt = compactionMessages[1]?.content ?? '';
  assert.match(prompt, /<transcript>/);
  assert.match(prompt, /<file_operations>/);
  assert.match(prompt, /Read files:\n- src\/index\.ts/);
  assert.match(prompt, /Modified files:\n- src\/output\.ts/);
});
