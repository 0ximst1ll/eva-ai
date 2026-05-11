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
  const contextManager = createContextManager({ contextBuilder, sessionManager });

  const beforeBuild = contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    maxSteps: null,
  });
  assert.equal(beforeBuild.activeMessageCount, 2);
  assert.equal(beforeBuild.activeMessageTokenEstimate.method, 'gpt-tokenizer');
  assert.ok(beforeBuild.activeMessageTokenEstimate.tokens > 0);
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
  const afterBuild = contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
    maxSteps: 8,
  });
  assert.deepEqual(afterBuild.stepGuard, { enabled: true, maxSteps: 8 });
  assert.equal(afterBuild.latestBuild?.injected, true);
  assert.equal(afterBuild.latestBuild?.projectContextCount, 1);
  assert.ok((afterBuild.latestBuild?.requestTokenEstimate.tokens ?? 0) > 0);
  assert.ok((afterBuild.latestBuild?.projectContextTokenEstimate.tokens ?? 0) > 0);
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
  const diagnostics = contextManager.getDiagnostics({
    sessionId,
    messages: sessionManager.getMessages(sessionId),
  });

  assert.equal(contextManager.contextBuilder, nextContextBuilder);
  assert.equal(diagnostics.projectContext.resources[0]?.content, 'new instructions');
});
