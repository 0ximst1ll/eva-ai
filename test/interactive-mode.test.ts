import assert from 'node:assert/strict';
import test from 'node:test';
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

test('non-slash input is not handled as an interactive command', async () => {
  const result = await handleInteractiveCommand({
    userInput: 'hello',
    host: {} as RuntimeHost,
  });

  assert.equal(result, 'not_command');
});

