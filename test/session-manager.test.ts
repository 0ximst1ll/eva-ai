import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/core/session-manager.js';

test('SessionManager stores and resets memory sessions', async () => {
  const manager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await manager.createSession('system');
  assert.deepEqual(manager.getCompactionInfo(sessionId), { compacted: false });
  assert.deepEqual(manager.getUsageInfo(sessionId), {
    count: 0,
    total: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });

  await manager.appendMessage(sessionId, { role: 'user', content: 'hello' });
  await manager.appendUsage({
    sessionId,
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
  assert.deepEqual(manager.getMessages(sessionId), [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(manager.getUsageInfo(sessionId), {
    count: 1,
    total: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
    latest: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
    latestTimestamp: manager.getUsageInfo(sessionId).latestTimestamp,
    latestSource: 'assistant',
  });

  await manager.resetSession(sessionId, 'reset system');
  assert.deepEqual(manager.getMessages(sessionId), [{ role: 'system', content: 'reset system' }]);
  assert.deepEqual(manager.getCompactionInfo(sessionId), { compacted: false });
  assert.deepEqual(manager.getUsageInfo(sessionId), {
    count: 0,
    total: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
  assert.deepEqual(
    (await manager.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      messageCount: session.messageCount,
      isLatest: session.isLatest,
    })),
    [{ sessionId, messageCount: 1, isLatest: true }],
  );
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
    await first.appendUsage({
      sessionId,
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });
    await first.appendUsage({
      sessionId,
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
    const secondSessionId = await first.createSession('other system', 'session-b');
    await first.appendMessage(secondSessionId, { role: 'user', content: 'other' });

    const listed = await first.listSessions();
    assert.equal(listed.length, 2);
    const sessionA = listed.find((session) => session.sessionId === 'session-a');
    const sessionB = listed.find((session) => session.sessionId === 'session-b');
    assert.equal(sessionA?.messageCount, 3);
    assert.equal(sessionA?.isLatest, false);
    assert.equal(sessionB?.messageCount, 2);
    assert.equal(sessionB?.isLatest, true);
    assert.ok((sessionA?.updatedAt ?? 0) > 0);
    assert.ok((sessionB?.updatedAt ?? 0) > 0);

    const latest = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await latest.loadLatestSession(), secondSessionId);
    assert.deepEqual(latest.getMessages(secondSessionId), [
      { role: 'system', content: 'other system' },
      { role: 'user', content: 'other' },
    ]);

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadSession(sessionId), true);
    assert.deepEqual(second.getUsageInfo(sessionId), {
      count: 2,
      total: {
        prompt_tokens: 18,
        completion_tokens: 7,
        total_tokens: 25,
      },
      latest: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
      latestTimestamp: second.getUsageInfo(sessionId).latestTimestamp,
      latestSource: 'assistant',
    });

    await second.resetSession(sessionId, 'new system');

    const third = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await third.loadSession(sessionId), true);
    assert.deepEqual(third.getMessages(sessionId), [{ role: 'system', content: 'new system' }]);
    assert.deepEqual(third.getUsageInfo(sessionId), {
      count: 0,
      total: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager appends compaction entries and rebuilds compacted context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-compact-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await first.createSession('system', 'session-compact');
    await first.appendMessage(sessionId, { role: 'user', content: 'first task' });
    await first.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
    await first.appendMessage(sessionId, { role: 'user', content: 'second task' });
    await first.appendMessage(sessionId, { role: 'assistant', content: 'second answer' });
    await first.appendMessage(sessionId, { role: 'user', content: 'third task' });
    await first.appendMessage(sessionId, { role: 'assistant', content: 'third answer' });

    const result = await first.appendCompaction({
      sessionId,
      summary: 'Summary of earlier work.',
      keepRecentMessages: 2,
    });

    assert.deepEqual(
      first.getMessages(sessionId).map((message) => message.content),
      [
        'system',
        '<conversation_summary>\nThe previous conversation was compacted. Use this summary as context for continuing the task.\n\nSummary of earlier work.\n</conversation_summary>',
        'third task',
        'third answer',
      ],
    );
    assert.equal(result.messagesBefore, 7);
    assert.equal(result.messagesAfter, 4);
    assert.deepEqual(first.getCompactionInfo(sessionId), {
      compacted: true,
      timestamp: first.getCompactionInfo(sessionId).timestamp,
      summaryLength: 24,
      firstKeptMessageIndex: 5,
      messagesBefore: 7,
      messagesAfter: 4,
      customInstructions: undefined,
    });
    assert.ok(first.getCompactionInfo(sessionId).timestamp);

    const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
    const rawLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-compact.jsonl'),
      'utf-8',
    );
    assert.match(rawLog, /"type":"message".*"first task"/);
    assert.match(rawLog, /"type":"compaction".*"Summary of earlier work\."/);

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadSession(sessionId), true);
    assert.deepEqual(second.getMessages(sessionId), first.getMessages(sessionId));
    assert.deepEqual(second.getCompactionInfo(sessionId), first.getCompactionInfo(sessionId));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager persists internal entries without adding provider messages', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-internal-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await first.createSession('system', 'session-internal');
    await first.appendMessage(sessionId, { role: 'user', content: 'hello' });

    const entry = await first.appendInternalEntry({
      sessionId,
      kind: 'permission_pending',
      content: 'Tool approval required',
      metadata: {
        toolName: 'bash',
        callId: 'call-1',
      },
    });

    assert.equal(entry.kind, 'permission_pending');
    assert.deepEqual(first.getInternalEntries(sessionId), [{
      timestamp: entry.timestamp,
      kind: 'permission_pending',
      content: 'Tool approval required',
      metadata: {
        toolName: 'bash',
        callId: 'call-1',
      },
    }]);
    assert.deepEqual(first.getInternalEntries(sessionId, 'resource_context'), []);
    assert.deepEqual(
      first.getMessages(sessionId).map((message) => message.content),
      ['system', 'hello'],
    );

    const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
    const rawLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-internal.jsonl'),
      'utf-8',
    );
    assert.match(rawLog, /"type":"internal"/);
    assert.match(rawLog, /"kind":"permission_pending"/);

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadSession(sessionId), true);
    assert.deepEqual(second.getMessages(sessionId), first.getMessages(sessionId));
    assert.deepEqual(second.getInternalEntries(sessionId), first.getInternalEntries(sessionId));

    await second.resetSession(sessionId, 'reset system');
    assert.deepEqual(second.getInternalEntries(sessionId), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
