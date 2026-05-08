import assert from 'node:assert/strict';
import test from 'node:test';
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

test('non-slash input is not handled as an interactive command', async () => {
  const result = await handleInteractiveCommand({
    userInput: 'hello',
    host: {} as RuntimeHost,
  });

  assert.equal(result, 'not_command');
});
