import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { createContextManager } from '../src/core/context-manager.js';
import type { ResourceSourceInfo } from '../src/core/resource-loader.js';
import { SessionManager } from '../src/core/session-manager.js';

const skillSourceInfo: ResourceSourceInfo = {
  source: 'config',
  scope: 'project',
  configuredPath: './skills',
  baseDir: '/workspace/skills',
};

test('ContextManager reports context diagnostics from builder and session metadata', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'hello' });
  await sessionManager.appendUsage({
    sessionId,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    },
  });
  const contextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: '# Project Instructions\n',
    }],
    skills: [
      {
        type: 'skill',
        name: 'review',
        description: 'Review changes',
        path: '/workspace/skills/review/SKILL.md',
        baseDir: '/workspace/skills/review',
        content: 'Review instructions.',
        disableModelInvocation: false,
        sourceInfo: skillSourceInfo,
      },
      {
        type: 'skill',
        name: 'hidden',
        description: 'Hidden skill',
        path: '/workspace/skills/hidden/SKILL.md',
        baseDir: '/workspace/skills/hidden',
        content: 'Hidden instructions.',
        disableModelInvocation: true,
        sourceInfo: skillSourceInfo,
      },
    ],
    projectContextMaxChars: 20000,
  });
  const contextManager = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
  });

  const beforeBuild = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    maxSteps: null,
  });
  assert.equal(beforeBuild.activeMessageCount, 2);
  assert.equal(beforeBuild.activeMessageTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(beforeBuild.activeMessageTokenEstimate.tokens > 0);
  assert.equal(beforeBuild.contextUsage.contextWindowTokens, 1000);
  assert.equal(beforeBuild.contextUsage.source, 'active_messages');
  assert.equal(beforeBuild.contextUsage.countSource, 'local');
  assert.equal(beforeBuild.compactionRecommendation.shouldCompact, false);
  assert.equal(beforeBuild.compactionRecommendation.reason, 'auto_disabled');
  assert.equal(
    beforeBuild.contextUsage.percent,
    (beforeBuild.activeMessageTokenEstimate.tokens / 1000) * 100,
  );
  assert.deepEqual(beforeBuild.stepGuard, { enabled: false });
  assert.equal(beforeBuild.projectContext.count, 1);
  assert.equal(beforeBuild.projectContext.budgetChars, 20000);
  assert.equal(beforeBuild.skills.count, 2);
  assert.equal(beforeBuild.skills.visibleCount, 1);
  assert.equal(beforeBuild.skills.hiddenCount, 1);
  assert.deepEqual(beforeBuild.skills.visibleNames, ['review']);
  assert.deepEqual(beforeBuild.skills.hiddenNames, ['hidden']);
  assert.deepEqual(beforeBuild.skills.latestInvokedNames, []);
  assert.equal(beforeBuild.latestBuild, null);
  assert.equal(beforeBuild.usage.count, 1);
  assert.equal(beforeBuild.usage.total.total_tokens, 14);
  assert.equal(beforeBuild.compaction.compacted, false);
  assert.deepEqual(beforeBuild.permissionPending, { count: 0, latest: null });
  assert.deepEqual(beforeBuild.permissionDenied, { count: 0, latest: null });

  contextBuilder.queueSkillInvocation('review');
  contextBuilder.build({
    systemPrompt: 'system',
    llmMessages: sessionManager.getMessages(sessionId),
  });
  const afterBuild = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    maxSteps: 8,
  });
  assert.deepEqual(afterBuild.stepGuard, { enabled: true, maxSteps: 8 });
  assert.equal(afterBuild.latestBuild?.injected, true);
  assert.equal(afterBuild.latestBuild?.projectContextCount, 1);
  assert.deepEqual(afterBuild.skills.latestInvokedNames, ['review']);
  assert.ok((afterBuild.latestBuild?.providerRequestTokenEstimate.tokens ?? 0) > 0);
  assert.ok((afterBuild.latestBuild?.projectContextTokenEstimate.tokens ?? 0) > 0);
  assert.equal(afterBuild.contextUsage.source, 'latest_provider_request_view');
  assert.equal(afterBuild.contextUsage.estimatedTokens, afterBuild.latestBuild?.providerRequestTokenEstimate.tokens);
});

test('ContextManager reports pending permission diagnostics from durable internal entries', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const pending = await sessionManager.appendInternalEntry({
    sessionId,
    kind: 'permission_pending',
    content: 'Tool permission pending: approval required',
    metadata: {
      toolName: 'write',
      toolCallId: 'call-1',
    },
  });
  const contextManager = createContextManager({
    contextBuilder: createContextBuilder(),
    sessionManager,
  });

  const diagnostics = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });

  assert.equal(diagnostics.permissionPending.count, 1);
  assert.deepEqual(diagnostics.permissionPending.latest, pending);
  assert.deepEqual(diagnostics.permissionDenied, { count: 0, latest: null });
});

test('ContextManager reports denied permission diagnostics from durable internal entries', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const denied = await sessionManager.appendInternalEntry({
    sessionId,
    kind: 'permission_denied',
    content: 'Tool execution denied: write',
    metadata: {
      toolName: 'write',
      toolCallId: 'call-1',
    },
  });
  const contextManager = createContextManager({
    contextBuilder: createContextBuilder(),
    sessionManager,
  });

  const diagnostics = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });

  assert.equal(diagnostics.permissionDenied.count, 1);
  assert.deepEqual(diagnostics.permissionDenied.latest, denied);
  assert.deepEqual(diagnostics.permissionPending, { count: 0, latest: null });
});

test('ContextManager uses provider token counts when a TokenCounter is available', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const contextBuilder = createContextBuilder();
  contextBuilder.build({
    systemPrompt: 'system',
    llmMessages: sessionManager.getMessages(sessionId),
  });
  const contextManager = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    tokenCounter: {
      async countMessages() {
        return {
          tokens: 250,
          source: 'provider',
          method: 'anthropic_count_tokens',
        };
      },
    },
  });

  const diagnostics = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });

  assert.equal(diagnostics.contextUsage.estimatedTokens, 250);
  assert.equal(diagnostics.contextUsage.countSource, 'provider');
  assert.equal(diagnostics.contextUsage.method, 'anthropic_count_tokens');
  assert.equal(diagnostics.contextUsage.percent, 25);
});

test('ContextManager can force usage diagnostics from active messages', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const contextBuilder = createContextBuilder();
  contextBuilder.build({
    systemPrompt: 'system',
    llmMessages: sessionManager.getMessages(sessionId),
  });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'new input' });
  let countedMessages: string[] = [];
  const contextManager = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    tokenCounter: {
      async countMessages({ messages }) {
        countedMessages = messages.map((message) => message.content);
        return { tokens: 250, source: 'provider', method: 'anthropic_count_tokens' };
      },
    },
  });

  const diagnostics = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    usageSource: 'active_messages',
  });

  assert.deepEqual(countedMessages, ['system', 'new input']);
  assert.equal(diagnostics.contextUsage.source, 'active_messages');
});

test('ContextManager recommends compaction only when the reserve is reached', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const contextBuilder = createContextBuilder();

  const belowReserve = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    compaction: {
      enabled: true,
      reserveTokens: 200,
    },
    tokenCounter: {
      async countMessages() {
        return { tokens: 700, source: 'provider', method: 'anthropic_count_tokens' };
      },
    },
  });
  const belowDiagnostics = await belowReserve.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });
  assert.equal(belowDiagnostics.compactionRecommendation.shouldCompact, false);
  assert.equal(belowDiagnostics.compactionRecommendation.reason, 'below_reserve');

  const reserveReached = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    compaction: {
      enabled: true,
      reserveTokens: 200,
    },
    tokenCounter: {
      async countMessages() {
        return { tokens: 850, source: 'provider', method: 'anthropic_count_tokens' };
      },
    },
  });
  const reserveDiagnostics = await reserveReached.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });
  assert.equal(reserveDiagnostics.compactionRecommendation.shouldCompact, true);
  assert.equal(reserveDiagnostics.compactionRecommendation.reason, 'reserve_reached');

  const unknownWindow = createContextManager({
    contextBuilder,
    sessionManager,
    compaction: {
      enabled: true,
      reserveTokens: 200,
    },
  });
  const unknownDiagnostics = await unknownWindow.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });
  assert.equal(unknownDiagnostics.compactionRecommendation.shouldCompact, false);
  assert.equal(unknownDiagnostics.compactionRecommendation.reason, 'context_window_unknown');
});

test('ContextManager updates diagnostics when the context builder changes', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-context');
  const contextManager = createContextManager({
    contextBuilder: createContextBuilder({
      projectContext: [{
        type: 'project_context',
        name: 'AGENTS.md',
        path: '/workspace/AGENTS.md',
        content: 'old instructions',
      }],
    }),
    sessionManager,
  });
  const nextContextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: 'new instructions',
    }],
  });

  contextManager.setContextBuilder(nextContextBuilder);
  const diagnostics = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });

  assert.equal(contextManager.contextBuilder, nextContextBuilder);
  assert.equal(diagnostics.projectContext.resources[0]?.content, 'new instructions');
  assert.equal(diagnostics.contextUsage.contextWindowTokens, null);
  assert.equal(diagnostics.contextUsage.percent, null);
});
