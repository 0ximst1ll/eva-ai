import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { RuntimeSessionNotFoundError } from '../src/core/runtime.js';
import type { RuntimeHost } from '../src/core/runtime-host.js';
import { handleInteractiveCommand } from '../src/modes/interactive-mode.js';

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
  const host = {
    get sessionId() {
      return 'session-stats';
    },
    get session() {
      return {
        apiTotalTokens: 123,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hello' },
        ],
      };
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
  assert.match(text, /Project context:.*1/);
  assert.match(text, /Context build:.*not built yet/);
});

test('/sessions prints workspace session list and marks the current session', async () => {
  const output: string[] = [];
  const host = {
    get sessionId() {
      return 'session-current';
    },
    get runtime() {
      return {
        sessionManager: {
          async listSessions() {
            return [
              {
                sessionId: 'session-current',
                messageCount: 3,
                updatedAt: Date.parse('2026-05-08T00:00:00.000Z'),
                isLatest: true,
              },
              {
                sessionId: 'session-old',
                messageCount: 1,
                updatedAt: Date.parse('2026-05-07T00:00:00.000Z'),
                isLatest: false,
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
  assert.match(text, /Workspace sessions:/);
  assert.match(text, /\* session-current messages=3 updated=2026-05-08T00:00:00\.000Z latest/);
  assert.match(text, /  session-old messages=1 updated=2026-05-07T00:00:00\.000Z/);
});

test('/sessions reports when the workspace has no sessions', async () => {
  const output: string[] = [];
  const host = {
    get runtime() {
      return {
        sessionManager: {
          async listSessions() {
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
    messages: [{ role: 'system', content: 'system' }],
  });
  const host = {
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
  assert.match(text, /AGENTS\.md path=\/workspace\/AGENTS\.md chars=23/);
  assert.match(text, /Budget: 20000 chars/);
  assert.match(text, /Last build: injected 1 resource\(s\).*chars=85\/20000/);
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
