import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS,
  createContextBuilder,
} from '../src/core/context-builder.js';
import { createCompactionSummaryMessage } from '../src/core/compaction.js';
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
  assert.equal(result.summary.injected, true);
  assert.equal(result.summary.requestTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(result.summary.requestTokenEstimate.tokens > 0);
  assert.ok(result.summary.projectContextTokenEstimate.tokens > 0);
  assert.deepEqual(builder.latestBuild, result.summary);
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
  assert.equal(result.summary.injected, false);
  assert.equal(result.summary.requestTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(result.summary.requestTokenEstimate.tokens > 0);
  assert.equal(result.summary.projectContextTokenEstimate.tokens, 0);
  assert.deepEqual(builder.latestBuild, result.summary);
});

test('ContextBuilder truncates project context to the configured budget', () => {
  const builder = createContextBuilder({
    projectContext: [{
      ...agentsResource,
      content: 'A'.repeat(200),
    }],
    projectContextMaxChars: 120,
  });

  const result = builder.build({
    systemPrompt: 'system',
    messages: [{ role: 'system', content: 'system' }],
  });

  assert.equal(result.summary.injected, true);
  assert.equal(result.summary.projectContextTruncated, true);
  assert.equal(result.summary.projectContextMaxChars, 120);
  assert.equal(result.messages[1]?.content.length, 120);
  assert.match(result.messages[1]?.content ?? '', /Project context truncated to fit budget/);
  assert.equal(result.diagnostics[0]?.code, 'project_context_truncated');
});

test('ContextBuilder uses a conservative project context budget after compaction', () => {
  const builder = createContextBuilder({
    projectContext: [{
      ...agentsResource,
      content: 'A'.repeat(8000),
    }],
    projectContextMaxChars: 20000,
  });

  const result = builder.build({
    systemPrompt: 'system',
    messages: [
      { role: 'system', content: 'system' },
      createCompactionSummaryMessage('Previous work summary.'),
      { role: 'user', content: 'continue' },
    ],
  });

  assert.equal(result.summary.compactedContext, true);
  assert.equal(result.summary.projectContextBudgetMode, 'post_compact');
  assert.equal(result.summary.projectContextConfiguredMaxChars, 20000);
  assert.equal(result.summary.projectContextMaxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS);
  assert.equal(result.summary.projectContextTruncated, true);
  assert.equal(result.messages[1]?.content.length, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS);
  assert.equal(result.diagnostics[0]?.details?.budgetMode, 'post_compact');
});

test('ContextBuilder skips project context when the budget cannot fit framing', () => {
  const builder = createContextBuilder({
    projectContext: [agentsResource],
    projectContextMaxChars: 10,
  });

  const result = builder.build({
    systemPrompt: 'system',
    messages: [{ role: 'system', content: 'system' }],
  });

  assert.equal(result.summary.injected, false);
  assert.equal(result.summary.projectContextSkippedReason, 'budget_exhausted');
  assert.deepEqual(result.messages.map((message) => message.content), ['system']);
  assert.equal(result.diagnostics[0]?.code, 'project_context_skipped_budget');
});
