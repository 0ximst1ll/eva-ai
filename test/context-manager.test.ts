import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { createContextManager } from '../src/core/context-manager.js';
import { SessionManager } from '../src/core/session-manager.js';

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
  assert.equal(beforeBuild.latestBuild, null);
  assert.equal(beforeBuild.usage.count, 1);
  assert.equal(beforeBuild.usage.total.total_tokens, 14);
  assert.equal(beforeBuild.compaction.compacted, false);

  contextBuilder.build({
    systemPrompt: 'system',
    messages: sessionManager.getMessages(sessionId),
  });
  const afterBuild = await contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    maxSteps: 8,
  });
  assert.deepEqual(afterBuild.stepGuard, { enabled: true, maxSteps: 8 });
  assert.equal(afterBuild.latestBuild?.injected, true);
  assert.equal(afterBuild.latestBuild?.projectContextCount, 1);
  assert.ok((afterBuild.latestBuild?.requestTokenEstimate.tokens ?? 0) > 0);
  assert.ok((afterBuild.latestBuild?.projectContextTokenEstimate.tokens ?? 0) > 0);
  assert.equal(afterBuild.contextUsage.source, 'latest_request');
  assert.equal(afterBuild.contextUsage.estimatedTokens, afterBuild.latestBuild?.requestTokenEstimate.tokens);
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
    messages: sessionManager.getMessages(sessionId),
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
    messages: sessionManager.getMessages(sessionId),
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
