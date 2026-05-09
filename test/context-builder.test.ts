import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import type { ProjectContextResource } from '../src/core/resource-loader.js';
import type { Message } from '../src/schema.js';

const agentsResource: ProjectContextResource = {
  type: 'project_context',
  name: 'AGENTS.md',
  path: '/workspace/AGENTS.md',
  content: '# Project Instructions\nUse rg before grep.\n',
};

test('ContextBuilder injects project context after the system message', () => {
  const builder = createContextBuilder({ projectContext: [agentsResource] });
  const durableMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];

  const result = builder.build({
    systemPrompt: 'system',
    messages: durableMessages,
  });

  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages[0], durableMessages[0]);
  assert.equal(result.messages[1]?.role, 'user');
  assert.match(result.messages[1]?.content ?? '', /<project_context>/);
  assert.match(result.messages[1]?.content ?? '', /Contents of AGENTS\.md:/);
  assert.match(result.messages[1]?.content ?? '', /Use rg before grep\./);
  assert.deepEqual(result.messages[2], durableMessages[1]);
  assert.deepEqual(durableMessages.map((message) => message.content), ['system', 'hello']);
  assert.equal(result.diagnostics[0]?.code, 'project_context_injected');
});

test('ContextBuilder returns a shallow message copy when project context is empty', () => {
  const builder = createContextBuilder();
  const durableMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];

  const result = builder.build({
    systemPrompt: 'system',
    messages: durableMessages,
  });

  assert.notEqual(result.messages, durableMessages);
  assert.deepEqual(result.messages, durableMessages);
  assert.equal(result.diagnostics[0]?.code, 'project_context_empty');
});
