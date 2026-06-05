import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS,
  createContextBuilder,
} from '../src/core/context-builder.js';
import { createCompactionSummaryMessage } from '../src/core/compaction.js';
import type { ProjectContextResource, ResourceSourceInfo, SkillResource } from '../src/core/resource-loader.js';
import type { Message } from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

const agentsResource: ProjectContextResource = {
  type: 'project_context',
  name: 'AGENTS.md',
  path: '/workspace/AGENTS.md',
  content: '# Project Instructions\nUse rg before grep.\n',
};

const skillSourceInfo: ResourceSourceInfo = {
  source: 'config',
  scope: 'project',
  configuredPath: './skills',
  baseDir: '/workspace/skills',
};

const reviewSkill: SkillResource = {
  type: 'skill',
  name: 'code-review',
  description: 'Review code changes for defects',
  path: '/workspace/skills/review/SKILL.md',
  baseDir: '/workspace/skills/review',
  content: 'Full skill body should not be injected by default.',
  disableModelInvocation: false,
  sourceInfo: skillSourceInfo,
};

const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file inside the workspace.',
  promptSnippet: 'Create a new file or completely overwrite a file',
  promptGuidelines: [
    'Use write only for new files or complete rewrites.',
    'Always provide both required arguments: path and complete content.',
  ],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute() {
    return { success: true, content: 'ok' };
  },
};

test('ContextBuilder injects project context after the system message', () => {
  const builder = createContextBuilder({ projectContext: [agentsResource] });
  const durableMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];

  const result = builder.build({
    systemPrompt: 'system',
    llmMessages: durableMessages,
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
  assert.equal(result.summary.providerRequestTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(result.summary.providerRequestTokenEstimate.tokens > 0);
  assert.ok(result.summary.projectContextTokenEstimate.tokens > 0);
  assert.deepEqual(builder.latestBuild, result.summary);
  assert.deepEqual(builder.latestProviderRequestView?.messages, result.messages);
});

test('ContextBuilder appends skills metadata to the system message without injecting full skill content', () => {
  const builder = createContextBuilder({
    skills: [
      reviewSkill,
      {
        ...reviewSkill,
        name: 'hidden-skill',
        description: 'Hidden skill',
        content: 'Hidden full body.',
        disableModelInvocation: true,
      },
    ],
  });

  const result = builder.build({
    systemPrompt: 'system',
    llmMessages: [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'hello' },
    ],
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.role, 'system');
  assert.match(result.messages[0]?.content ?? '', /system/);
  assert.match(result.messages[0]?.content ?? '', /<available_skills>/);
  assert.match(result.messages[0]?.content ?? '', /name="code-review"/);
  assert.match(result.messages[0]?.content ?? '', /location="\/workspace\/skills\/review\/SKILL\.md"/);
  assert.match(result.messages[0]?.content ?? '', /Review code changes for defects/);
  assert.doesNotMatch(result.messages[0]?.content ?? '', /Full skill body should not be injected/);
  assert.doesNotMatch(result.messages[0]?.content ?? '', /hidden-skill/);
  assert.equal(result.summary.skillsMetadataInjected, true);
  assert.equal(result.summary.skillCount, 1);
  assert.deepEqual(result.summary.skillNames, ['code-review']);
});

test('ContextBuilder appends active tool prompt metadata to the system message', () => {
  const builder = createContextBuilder({ tools: [writeTool] });

  const result = builder.build({
    systemPrompt: 'system',
    llmMessages: [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'hello' },
    ],
  });

  const system = result.messages[0]?.content ?? '';
  assert.match(system, /Available tools:/);
  assert.match(system, /- write: Create a new file or completely overwrite a file Required arguments: path, content\./);
  assert.match(system, /Guidelines:/);
  assert.match(system, /Use write only for new files or complete rewrites/);
  assert.match(system, /Always provide both required arguments: path and complete content/);
  assert.doesNotMatch(system, /<available_tools>/);
  assert.doesNotMatch(system, /<tool name="write">/);
  assert.equal(result.summary.toolPromptMetadataInjected, true);
  assert.equal(result.summary.toolCount, 1);
  assert.deepEqual(result.summary.toolNames, ['write']);
});

test('ContextBuilder injects queued skill invocation once without persisting it in input messages', () => {
  const builder = createContextBuilder({ skills: [reviewSkill] });
  const queued = builder.queueSkillInvocation('code-review');
  assert.equal(queued.ok, true);

  const durableMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'review this change' },
  ];
  const result = builder.build({
    systemPrompt: 'system',
    llmMessages: durableMessages,
  });

  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1]?.role, 'user');
  assert.match(result.messages[1]?.content ?? '', /<invoked_skills>/);
  assert.match(result.messages[1]?.content ?? '', /name="code-review"/);
  assert.match(result.messages[1]?.content ?? '', /Full skill body should not be injected by default/);
  assert.equal(result.summary.skillInvocationInjected, true);
  assert.equal(result.summary.skillInvocationCount, 1);
  assert.deepEqual(result.summary.invokedSkillNames, ['code-review']);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === 'skills_invoked'), true);
  assert.deepEqual(durableMessages.map((message) => message.content), ['system', 'review this change']);

  const nextResult = builder.build({
    systemPrompt: 'system',
    llmMessages: durableMessages,
  });
  assert.equal(nextResult.summary.skillInvocationInjected, false);
  assert.equal(nextResult.messages.length, 2);
  assert.doesNotMatch(nextResult.messages.map((message) => message.content).join('\n'), /<invoked_skills>/);
});

test('ContextBuilder returns a shallow message copy when project context is empty', () => {
  const builder = createContextBuilder();
  const durableMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];

  const result = builder.build({
    systemPrompt: 'system',
    llmMessages: durableMessages,
  });

  assert.notEqual(result.messages, durableMessages);
  assert.deepEqual(result.messages, durableMessages);
  assert.equal(result.diagnostics[0]?.code, 'project_context_empty');
  assert.equal(result.summary.injected, false);
  assert.equal(result.summary.providerRequestTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(result.summary.providerRequestTokenEstimate.tokens > 0);
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
    llmMessages: [{ role: 'system', content: 'system' }],
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
    llmMessages: [
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
    llmMessages: [{ role: 'system', content: 'system' }],
  });

  assert.equal(result.summary.injected, false);
  assert.equal(result.summary.projectContextSkippedReason, 'budget_exhausted');
  assert.deepEqual(result.messages.map((message) => message.content), ['system']);
  assert.equal(result.diagnostics[0]?.code, 'project_context_skipped_budget');
});
