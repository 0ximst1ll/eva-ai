import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { RuntimeSessionNotFoundError } from '../src/core/runtime.js';
import type { RuntimeHost } from '../src/core/runtime-host.js';
import { defaultConvertToLlm } from '../src/core/agent-messages.js';
import { estimateMessagesTokens } from '../src/core/token-estimator.js';
import { handleInteractiveCommand } from '../src/modes/interactive-mode.js';

function createContextManagerMock({
  contextBuilder = createContextBuilder(),
  session,
  contextWindowTokens = null,
}: {
  contextBuilder?: ReturnType<typeof createContextBuilder>;
  session: {
    compaction: RuntimeHost['session']['compaction'];
    usage: RuntimeHost['session']['usage'];
  };
  contextWindowTokens?: number | null;
}) {
  return {
    getDiagnostics({
      messages,
      maxSteps,
    }: {
      messages: RuntimeHost['session']['messages'];
      maxSteps?: number | null;
    }) {
      const activeMessageTokenEstimate = estimateMessagesTokens(defaultConvertToLlm(messages));
      const latestBuild = contextBuilder.latestBuild;
      const contextUsageEstimate = latestBuild?.providerRequestTokenEstimate ?? activeMessageTokenEstimate;
      const contextUsage = {
        estimatedTokens: contextUsageEstimate.tokens,
        contextWindowTokens,
        percent: contextWindowTokens ? (contextUsageEstimate.tokens / contextWindowTokens) * 100 : null,
        source: latestBuild ? 'latest_provider_request_view' : 'active_messages',
        countSource: 'local',
        method: contextUsageEstimate.method,
      };
      return {
        activeMessageCount: messages.length,
        activeMessageTokenEstimate,
        contextUsage,
        compactionRecommendation: {
          shouldCompact: false,
          reason: 'auto_disabled',
          autoEnabled: false,
          reserveTokens: 16384,
          estimatedTokens: contextUsage.estimatedTokens,
          contextWindowTokens,
          usagePercent: contextUsage.percent,
        },
        stepGuard: typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
          ? { enabled: true, maxSteps }
          : { enabled: false },
        compaction: session.compaction,
        usage: session.usage,
        permissionPending: { count: 0, latest: null },
        projectContext: {
          count: contextBuilder.projectContext.length,
          resources: contextBuilder.projectContext,
          budgetChars: contextBuilder.projectContextMaxChars,
        },
        latestBuild: contextBuilder.latestBuild,
      };
    },
  };
}

test('/new creates a new runtime session through RuntimeHost', async () => {
  let sessionId = 'session-old';
  let newSessionCalls = 0;
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async newSession() {
      newSessionCalls += 1;
      sessionId = 'session-new';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/new',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.equal(newSessionCalls, 1);
  assert.equal(sessionId, 'session-new');
  assert.match(output.join('\n'), /Created new session: .*session-new/);
  assert.match(output.join('\n'), /Previous session: .*session-old/);
});

test('/resume resumes the latest runtime session through RuntimeHost', async () => {
  let sessionId = 'session-current';
  let resumeLatestCalls = 0;
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async resumeLatestSession() {
      resumeLatestCalls += 1;
      sessionId = 'session-latest';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/resume',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.equal(resumeLatestCalls, 1);
  assert.equal(sessionId, 'session-latest');
  assert.match(output.join('\n'), /Resumed latest session: .*session-latest/);
  assert.match(output.join('\n'), /Previous session: .*session-current/);
});

test('/resume <id> switches to the requested runtime session through RuntimeHost', async () => {
  let sessionId = 'session-current';
  const switchedSessionIds: string[] = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async switchSession(nextSessionId: string) {
      switchedSessionIds.push(nextSessionId);
      sessionId = nextSessionId;
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/resume Session-ABC',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(switchedSessionIds, ['Session-ABC']);
  assert.equal(sessionId, 'Session-ABC');
  assert.match(output.join('\n'), /Resumed session: .*Session-ABC/);
});

test('/resume <id> reports missing sessions without throwing', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    async switchSession() {
      throw new RuntimeSessionNotFoundError('missing-session');
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/resume missing-session',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Session not found: .*missing-session/);
});

test('/fork forks the active runtime session through RuntimeHost', async () => {
  let sessionId = 'session-current';
  const forkedSessions: Array<{ sessionId?: string; leafEntryId?: string }> = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async forkSession(nextSessionId?: string, leafEntryId?: string) {
      forkedSessions.push({ sessionId: nextSessionId, leafEntryId });
      sessionId = nextSessionId ?? 'session-fork';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/fork Session-Fork --entry entry-1',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(forkedSessions, [{ sessionId: 'Session-Fork', leafEntryId: 'entry-1' }]);
  assert.equal(sessionId, 'Session-Fork');
  assert.match(output.join('\n'), /Forked session: .*Session-Fork/);
  assert.match(output.join('\n'), /Parent session: .*session-current/);
});

test('/clone clones the active runtime session through RuntimeHost', async () => {
  let sessionId = 'session-current';
  const clonedSessions: Array<{ sessionId?: string; leafEntryId?: string }> = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async cloneSession(nextSessionId?: string, leafEntryId?: string) {
      clonedSessions.push({ sessionId: nextSessionId, leafEntryId });
      sessionId = nextSessionId ?? 'session-clone';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/clone --entry entry-2',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(clonedSessions, [{ sessionId: undefined, leafEntryId: 'entry-2' }]);
  assert.equal(sessionId, 'session-clone');
  assert.match(output.join('\n'), /Cloned session: .*session-clone/);
  assert.match(output.join('\n'), /Source session: .*session-current/);
});

test('/branch moves the active runtime session leaf through RuntimeHost', async () => {
  const branchedEntryIds: string[] = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    branchSession(leafEntryId: string) {
      branchedEntryIds.push(leafEntryId);
      return {
        sessionId: 'session-current',
        leafEntryId,
        pathEntryCount: 3,
        messageCount: 2,
        targetEntry: {
          entryId: leafEntryId,
          parentEntryId: 'entry-0',
          type: 'message',
          timestamp: Date.parse('2026-05-08T00:00:01.000Z'),
          isActive: true,
          isActivePath: true,
          messageIndex: 1,
          messageRole: 'user',
          preview: 'branch target',
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/branch entry-1',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(branchedEntryIds, ['entry-1']);
  assert.match(output.join('\n'), /Branched current session at entry: entry-1/);
  assert.match(output.join('\n'), /Path entries: 3, messages: 2, target: entry-1 type=message role=user message_index=1 preview="branch target"/);
});

test('/branch reports missing entry id without throwing', async () => {
  const output: string[] = [];
  const host = {} as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/branch',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Branch requires an entry id/);
});

test('/branch reports missing target entry without throwing', async () => {
  const output: string[] = [];
  const host = {
    branchSession() {
      throw new Error('Entry not found in session session-current: missing-entry');
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/branch missing-entry',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Entry not found: missing-entry/);
  assert.match(output.join('\n'), /Run \/entries/);
});

test('/export exports the active runtime session through RuntimeHost', async () => {
  const exportedPaths: Array<string | undefined> = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    async exportSession(outputPath?: string) {
      exportedPaths.push(outputPath);
      return '/tmp/session-current.jsonl';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/export /tmp/session-current.jsonl',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(exportedPaths, ['/tmp/session-current.jsonl']);
  assert.match(output.join('\n'), /Exported session: .*session-current/);
  assert.match(output.join('\n'), /Path:.*\/tmp\/session-current\.jsonl/);
});

test('/import imports and switches sessions through RuntimeHost', async () => {
  let sessionId = 'session-current';
  const importedPaths: string[] = [];
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async importSession(inputPath: string) {
      importedPaths.push(inputPath);
      sessionId = 'session-imported';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/import /tmp/session-imported.jsonl',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.deepEqual(importedPaths, ['/tmp/session-imported.jsonl']);
  assert.equal(sessionId, 'session-imported');
  assert.match(output.join('\n'), /Imported session: .*session-imported/);
  assert.match(output.join('\n'), /Previous session: .*session-current/);
});

test('/import reports missing path without throwing', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/import',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Import requires a JSONL path/);
});

test('/parent switches to the parent runtime session', async () => {
  let sessionId = 'session-child';
  let switchToParentCalls = 0;
  const output: string[] = [];
  const host = {
    get sessionId() {
      return sessionId;
    },
    async switchToParentSession() {
      switchToParentCalls += 1;
      sessionId = 'session-parent';
      return {};
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/parent',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.equal(switchToParentCalls, 1);
  assert.equal(sessionId, 'session-parent');
  assert.match(output.join('\n'), /Switched to parent session: .*session-parent/);
  assert.match(output.join('\n'), /Previous session: .*session-child/);
});

test('/parent reports when the current session has no parent', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-root';
    },
    async switchToParentSession() {
      return null;
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/parent',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /No parent session/);
});

test('/history prints current session id and message count', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-history';
    },
    get session() {
      return {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/history',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Current session:.*session-history/);
  assert.match(output.join('\n'), /Message count:.*3/);
});

test('/stats prints session and runtime details', async () => {
  const output: string[] = [];
  const contextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: '# Project Instructions\n',
    }],
    projectContextMaxChars: 20000,
  });
  const session = {
    apiTotalTokens: 123,
    maxSteps: null,
    compaction: { compacted: false },
    usage: {
      count: 2,
      total: {
        prompt_tokens: 80,
        completion_tokens: 43,
        total_tokens: 123,
      },
      latest: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
      latestTimestamp: Date.parse('2026-05-10T00:00:00.000Z'),
      latestSource: 'assistant' as const,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
  };
  const host = {
    get sessionId() {
      return 'session-stats';
    },
    get session() {
      return session;
    },
    get runtime() {
      return {
        config: {
          llm: {
            provider: 'anthropic',
            model: 'MiniMax-M2.5',
          },
        },
        tools: [{ name: 'read_file' }, { name: 'bash' }],
        services: {
          contextBuilder,
          contextManager: createContextManagerMock({ contextBuilder, session, contextWindowTokens: 100000 }),
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/stats',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.match(text, /Session:.*session-stats/);
  assert.match(text, /Messages:.*2/);
  assert.match(text, /API total tokens:.*123/);
  assert.match(text, /Provider:.*anthropic/);
  assert.match(text, /Model:.*MiniMax-M2\.5/);
  assert.match(text, /Tools:.*2/);
  assert.match(text, /Step guard:.*disabled/);
  assert.match(text, /Compaction:.*none/);
  assert.match(text, /Token usage:.*calls=2, prompt=80, completion=43, total=123/);
  assert.match(text, /Latest usage:.*source=assistant, prompt=30, completion=20, total=50, at=2026-05-10T00:00:00\.000Z/);
  assert.match(text, /Context usage:.*estimated=\d+, window=100000, percent=\d+\.\d%, source=active_messages, count=local, method=gpt-tokenizer/);
  assert.match(text, /Compaction recommendation:.*no, reason=auto_disabled, auto=disabled/);
  assert.match(text, /Estimated tokens:.*active=\d+, method=gpt-tokenizer/);
  assert.match(text, /Project context:.*1/);
  assert.match(text, /Context build:.*not built yet/);
});

test('/stats prints compacted context details', async () => {
  const output: string[] = [];
  const session = {
    apiTotalTokens: 0,
    maxSteps: 12,
    compaction: {
      compacted: true,
      summaryLength: 42,
      messagesBefore: 10,
      messagesAfter: 5,
      firstKeptMessageIndex: 6,
    },
    usage: {
      count: 0,
      total: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    },
    messages: [{ role: 'system', content: 'system' }],
  };
  const host = {
    get sessionId() {
      return 'session-compacted';
    },
    get session() {
      return session;
    },
    get runtime() {
      return {
        config: {
          llm: {
            provider: 'anthropic',
            model: 'MiniMax-M2.5',
          },
        },
        tools: [],
        services: {
          contextManager: createContextManagerMock({ session }),
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/stats',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.match(text, /Step guard:.*max_steps=12/);
  assert.match(text, /Compaction:.*compacted messages 10 -> 5, summary chars=42/);
});

test('/sessions prints workspace session tree and marks the current session', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-child';
    },
    get runtime() {
      return {
        sessionManager: {
          async listSessionTree() {
            return [
              {
                session: {
                  sessionId: 'session-root',
                  messageCount: 1,
                  updatedAt: Date.parse('2026-05-07T00:00:00.000Z'),
                  isLatest: false,
                  rootSessionId: 'session-root',
                },
                children: [
                  {
                    session: {
                      sessionId: 'session-child',
                      messageCount: 3,
                      updatedAt: Date.parse('2026-05-08T00:00:00.000Z'),
                      isLatest: true,
                      parentSessionId: 'session-root',
                      rootSessionId: 'session-root',
                      forkedFromMessageIndex: 1,
                    },
                    children: [],
                  },
                ],
              },
            ];
          },
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/sessions',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.match(text, /Workspace session tree:/);
  assert.match(text, /  session-root messages=1 updated=2026-05-07T00:00:00\.000Z/);
  assert.match(text, /\* session-child messages=3 updated=2026-05-08T00:00:00\.000Z latest forked_from=1/);
});

test('/sessions reports when the workspace has no sessions', async () => {
  const output: string[] = [];
  const host = {
    get runtime() {
      return {
        sessionManager: {
          async listSessionTree() {
            return [];
          },
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/sessions',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /No sessions found/);
});

test('/entries prints current session entry tree with entry ids', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    get runtime() {
      return {
        sessionManager: {
          listEntryTree(sessionId: string) {
            assert.equal(sessionId, 'session-current');
            return [
              {
                entry: {
                  entryId: 'entry-system',
                  parentEntryId: null,
                  type: 'message',
                  timestamp: Date.parse('2026-05-08T00:00:00.000Z'),
                  isActive: false,
                  isActivePath: true,
                  messageIndex: 0,
                  messageRole: 'system',
                  preview: 'system prompt',
                },
                children: [
                  {
                    entry: {
                      entryId: 'entry-user',
                      parentEntryId: 'entry-system',
                      type: 'message',
                      timestamp: Date.parse('2026-05-08T00:00:01.000Z'),
                      isActive: true,
                      isActivePath: true,
                      messageIndex: 1,
                      messageRole: 'user',
                      preview: 'user task',
                    },
                    children: [],
                  },
                ],
              },
            ];
          },
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/entries',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.match(text, /Current session entries:/);
  assert.match(text, /\+ entry-system type=message active_path=true role=system message_index=0 parent=root/);
  assert.match(text, /\* entry-user type=message active_path=true role=user message_index=1 parent=entry-system/);
  assert.match(text, /preview="user task"/);
});

test('/entries reports when the current session has no entry tree metadata', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    get runtime() {
      return {
        sessionManager: {
          listEntryTree() {
            return [];
          },
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/entries',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /No entry tree metadata found/);
});

test('/diagnostics prints full runtime diagnostics', async () => {
  const output: string[] = [];
  const contextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: '# Project Instructions\n',
    }],
    projectContextMaxChars: 20000,
  });
  contextBuilder.build({
    systemPrompt: 'system',
    llmMessages: [{ role: 'system', content: 'system' }],
  });
  const session = {
    maxSteps: null,
    compaction: {
      compacted: true,
      timestamp: Date.parse('2026-05-10T00:00:00.000Z'),
      summaryLength: 40,
      firstKeptMessageIndex: 4,
      messagesBefore: 9,
      messagesAfter: 5,
      customInstructions: 'focus',
    },
    usage: {
      count: 1,
      total: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
      },
      latest: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
      },
      latestTimestamp: Date.parse('2026-05-10T00:01:00.000Z'),
      latestSource: 'compaction' as const,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'summary' },
      { role: 'user', content: 'next' },
    ],
  };
  const host = {
    get sessionId() {
      return 'session-diagnostics';
    },
    get session() {
      return session;
    },
    get runtime() {
      return {
        diagnostics: [
          {
            source: 'config',
            level: 'info',
            type: 'info',
            code: 'config_loaded',
            message: 'Loaded config',
          },
          {
            source: 'resource',
            level: 'warning',
            type: 'warning',
            code: 'system_prompt_missing',
            message: 'System prompt not found',
          },
        ],
        services: {
          contextBuilder,
          contextManager: createContextManagerMock({ contextBuilder, session, contextWindowTokens: 100000 }),
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/diagnostics',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.match(text, /Runtime diagnostics:/);
  assert.match(text, /\[info\] config:config_loaded Loaded config/);
  assert.match(text, /\[warning\] resource:system_prompt_missing System prompt not found/);
  assert.match(text, /Context:/);
  assert.match(text, /Active messages: 3/);
  assert.match(text, /Step guard: disabled/);
  assert.match(text, /Compaction: compacted messages 9 -> 5, summary chars=40/);
  assert.match(text, /First kept message index: 4/);
  assert.match(text, /Compacted at: 2026-05-10T00:00:00\.000Z/);
  assert.match(text, /Custom instructions: yes/);
  assert.match(text, /Token usage: calls=1, prompt=100, completion=25, total=125/);
  assert.match(text, /Latest usage: source=compaction, prompt=100, completion=25, total=125, at=2026-05-10T00:01:00\.000Z/);
  assert.match(text, /Context usage: estimated=\d+, window=100000, percent=\d+\.\d%, source=latest_provider_request_view, count=local, method=gpt-tokenizer/);
  assert.match(text, /Compaction recommendation: no, reason=auto_disabled, auto=disabled/);
  assert.match(text, /Estimated tokens: active=\d+, provider_request=\d+, project_context=\d+, method=gpt-tokenizer/);
  assert.match(text, /AGENTS\.md path=\/workspace\/AGENTS\.md chars=23/);
  assert.match(text, /Budget: 20000 chars/);
  assert.match(text, /Last build: injected 1 resource\(s\).*estimated provider request tokens=\d+.*chars=85\/20000/);
});

test('/reload reloads runtime resources through RuntimeHost', async () => {
  const output: string[] = [];
  let reloadCalls = 0;
  const host = {
    async reloadResources() {
      reloadCalls += 1;
      return {
        resourceLoader: {
          projectContext: [
            {
              name: 'AGENTS.md',
              path: '/workspace/AGENTS.md',
              content: '# Project Instructions\n',
            },
          ],
        },
        systemPromptPath: '/workspace/system_prompt.md',
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/reload',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.equal(reloadCalls, 1);
  assert.match(text, /Reloaded runtime resources/);
  assert.match(text, /Project context:.*1/);
  assert.match(text, /System prompt:.*system_prompt\.md/);
});

test('/compact compacts the current session through AgentSession', async () => {
  const output: string[] = [];
  const customInstructions: Array<string | undefined> = [];
  const host = {
    get session() {
      return {
        async compact(instructions?: string) {
          customInstructions.push(instructions);
          return {
            summary: 'summary',
            firstKeptMessageIndex: 3,
            messagesBefore: 10,
            messagesAfter: 5,
          };
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/compact focus on current bug',
    host,
    writeLine: (message = '') => output.push(message),
  });
  const text = output.join('\n');

  assert.equal(result, 'continue');
  assert.deepEqual(customInstructions, ['focus on current bug']);
  assert.match(text, /Compacted current session/);
  assert.match(text, /Messages:.*10 -> 5/);
  assert.match(text, /Kept from message index:.*3/);
});

test('/compact reports compaction failures without throwing', async () => {
  const output: string[] = [];
  const host = {
    get session() {
      return {
        async compact() {
          throw new Error('Nothing to compact');
        },
      };
    },
  } as unknown as RuntimeHost;

  const result = await handleInteractiveCommand({
    userInput: '/compact',
    host,
    writeLine: (message = '') => output.push(message),
  });

  assert.equal(result, 'continue');
  assert.match(output.join('\n'), /Compact failed: Nothing to compact/);
});

test('non-slash input is not handled as an interactive command', async () => {
  const result = await handleInteractiveCommand({
    userInput: 'hello',
    host: {} as RuntimeHost,
  });

  assert.equal(result, 'not_command');
});
