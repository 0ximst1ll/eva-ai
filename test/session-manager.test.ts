import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/core/session-manager.js';

test('SessionManager stores and resets memory sessions', async () => {
  const manager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await manager.createSession('system');

  await manager.appendMessage(sessionId, { role: 'user', content: 'hello' });
  assert.deepEqual(manager.getMessages(sessionId), [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);

  await manager.resetSession(sessionId, 'reset system');
  assert.deepEqual(manager.getMessages(sessionId), [{ role: 'system', content: 'reset system' }]);
  assert.equal(await manager.loadLatestSession(), null);
});

test('SessionManager persists and reloads jsonl sessions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await first.createSession('system', 'session-a');
    await first.appendMessage(sessionId, { role: 'user', content: 'hello' });
    await first.appendMessage(sessionId, { role: 'assistant', content: 'hi' });

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadLatestSession(), sessionId);
    assert.deepEqual(second.getMessages(sessionId), [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);

    await second.resetSession(sessionId, 'new system');

    const third = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await third.loadSession(sessionId), true);
    assert.deepEqual(third.getMessages(sessionId), [{ role: 'system', content: 'new system' }]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

