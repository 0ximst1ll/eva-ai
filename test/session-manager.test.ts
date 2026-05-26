import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildSessionStateFromEntryPath,
  CURRENT_SESSION_SCHEMA_VERSION,
  SessionManager,
} from '../src/core/session-manager.js';
import { MemorySessionStorage } from '../src/core/session-store.js';

test('SessionManager stores and resets memory sessions', async () => {
  const manager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await manager.createSession('system');
  assert.deepEqual(manager.getLineageInfo(sessionId), {
    sessionId,
    rootSessionId: sessionId,
    createdAt: manager.getLineageInfo(sessionId).createdAt,
  });
  assert.deepEqual(manager.getCompactionInfo(sessionId), { compacted: false });
  assert.deepEqual(manager.getUsageInfo(sessionId), {
    count: 0,
    total: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
  assert.deepEqual(manager.getActiveState(sessionId), buildSessionStateFromEntryPath(manager.getEntryPath(sessionId)));

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
  assert.deepEqual(manager.getActiveState(sessionId), buildSessionStateFromEntryPath(manager.getEntryPath(sessionId)));
  assert.deepEqual(
    (await manager.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      messageCount: session.messageCount,
      isLatest: session.isLatest,
    })),
    [{ sessionId, messageCount: 1, isLatest: true }],
  );
  assert.equal(await manager.loadLatestSession(), sessionId);
});

test('SessionManager can share a memory storage backend across managers', async () => {
  const storage = new MemorySessionStorage();
  const first = new SessionManager({ workspaceDir: '/workspace', storage });
  const sessionId = await first.createSession('system', 'session-a');
  await first.appendMessage(sessionId, { role: 'user', content: 'hello' });

  const second = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await second.loadLatestSession(), sessionId);
  assert.deepEqual(second.getMessages(sessionId), [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(
    (await second.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      messageCount: session.messageCount,
      isLatest: session.isLatest,
    })),
    [{ sessionId, messageCount: 2, isLatest: true }],
  );
});

test('SessionManager preserves active path parent invariants across append, branch, and reset', async () => {
  const manager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await manager.createSession('system');
  await manager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  const firstTaskEntryId = manager.getEntryPath(sessionId).at(-1)?.entryId;
  assert.ok(firstTaskEntryId);

  await manager.appendMessage(sessionId, { role: 'assistant', content: 'main answer' });
  const mainPath = manager.getEntryPath(sessionId);
  assert.equal(mainPath.at(-1)?.parentEntryId, firstTaskEntryId);

  await manager.branchSession({ sessionId, leafEntryId: firstTaskEntryId });
  const branchSummaryEntry = manager.getEntryPath(sessionId).at(-1);
  assert.equal(branchSummaryEntry?.type, 'branch_summary');
  assert.equal(branchSummaryEntry?.parentEntryId, firstTaskEntryId);

  await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch answer' });
  const branchAnswerEntry = manager.getEntryPath(sessionId).at(-1);
  assert.equal(branchAnswerEntry?.type, 'message');
  assert.equal(branchAnswerEntry?.parentEntryId, branchSummaryEntry?.entryId);
  assert.deepEqual(manager.getActiveState(sessionId), buildSessionStateFromEntryPath(manager.getEntryPath(sessionId)));

  await manager.resetSession(sessionId, 'reset system');
  assert.deepEqual(manager.getMessages(sessionId), [{ role: 'system', content: 'reset system' }]);
  assert.deepEqual(manager.getEntryPath(sessionId).map((entry) => (
    entry.type === 'message' ? entry.message.content : entry.type
  )), ['reset system']);
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

test('SessionManager writes and reloads entry tree parent links', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-entry-tree-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await first.createSession('system', 'session-tree');
    await first.appendMessage(sessionId, { role: 'user', content: 'hello' });
    await first.appendUsage({
      sessionId,
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    await first.appendInternalEntry({
      sessionId,
      kind: 'permission_pending',
      content: 'approval required',
    });

    const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
    const rawLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-tree.jsonl'),
      'utf-8',
    );
    const entries = rawLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        type: string;
        entryId: string;
        parentEntryId: string | null;
        schemaVersion: number;
      });
    const startEntry = entries.find((entry) => entry.type === 'session_start');
    const messageEntries = entries.filter((entry) => entry.type === 'message');
    const usageEntry = entries.find((entry) => entry.type === 'usage');
    const internalEntry = entries.find((entry) => entry.type === 'internal');

    assert.equal(startEntry?.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
    assert.deepEqual(first.getSessionFormatInfo(sessionId), {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    });
    assert.equal(messageEntries.length, 2);
    assert.ok(messageEntries[0].entryId);
    assert.equal(messageEntries[0].parentEntryId, null);
    assert.ok(messageEntries[1].entryId);
    assert.equal(messageEntries[1].parentEntryId, messageEntries[0].entryId);
    assert.ok(usageEntry?.entryId);
    assert.equal(usageEntry.parentEntryId, messageEntries[1].entryId);
    assert.ok(internalEntry?.entryId);
    assert.equal(internalEntry.parentEntryId, usageEntry.entryId);
    assert.equal(first.getEntryTreeInfo(sessionId).activeEntryId, internalEntry.entryId);
    assert.deepEqual(
      first.getEntryPath(sessionId).map((entry) => entry.type),
      ['message', 'message', 'usage', 'internal'],
    );

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadSession(sessionId), true);
    assert.deepEqual(second.getSessionFormatInfo(sessionId), first.getSessionFormatInfo(sessionId));
    assert.deepEqual(second.getEntryTreeInfo(sessionId), first.getEntryTreeInfo(sessionId));
    assert.deepEqual(second.getEntryPath(sessionId), first.getEntryPath(sessionId));

    await second.appendMessage(sessionId, { role: 'assistant', content: 'after reload' });
    const reloadedRawLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-tree.jsonl'),
      'utf-8',
    );
    const reloadedEntries = reloadedRawLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        type: string;
        entryId: string;
        parentEntryId: string | null;
      });
    const lastEntry = reloadedEntries[reloadedEntries.length - 1];
    assert.equal(lastEntry?.type, 'message');
    assert.equal(lastEntry?.parentEntryId, internalEntry.entryId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager loadSession uses the active entry path when entries branch', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-entry-path-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');
  const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
  const workspaceDataDir = path.join(baseDir, workspaceKey);

  try {
    await fs.mkdir(workspaceDataDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDataDir, 'branch-session.jsonl'),
      [
        JSON.stringify({
          type: 'session_start',
          sessionId: 'branch-session',
          workspaceDir: path.resolve(workspaceDir),
          createdAt: 100,
          schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'branch-session',
          timestamp: 101,
          entryId: 'entry-system',
          parentEntryId: null,
          message: { role: 'system', content: 'system' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'branch-session',
          timestamp: 102,
          entryId: 'entry-root-task',
          parentEntryId: 'entry-system',
          message: { role: 'user', content: 'root task' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'branch-session',
          timestamp: 103,
          entryId: 'entry-skipped-answer',
          parentEntryId: 'entry-root-task',
          message: { role: 'assistant', content: 'skipped answer' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'branch-session',
          timestamp: 104,
          entryId: 'entry-branch-task',
          parentEntryId: 'entry-root-task',
          message: { role: 'user', content: 'branch task' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await manager.loadSession('branch-session'), true);
    assert.deepEqual(
      manager.getMessages('branch-session').map((message) => message.content),
      ['system', 'root task', 'branch task'],
    );

    await manager.appendMessage('branch-session', { role: 'assistant', content: 'branch answer' });
    const reloaded = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await reloaded.loadSession('branch-session'), true);
    assert.deepEqual(
      reloaded.getMessages('branch-session').map((message) => message.content),
      ['system', 'root task', 'branch task', 'branch answer'],
    );
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
      firstKeptEntryId: first.getCompactionInfo(sessionId).firstKeptEntryId,
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
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
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

test('SessionManager forks sessions with persistent lineage metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-fork-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sourceSessionId = await first.createSession('system', 'session-root');
    await first.appendMessage(sourceSessionId, { role: 'user', content: 'root task' });
    await first.appendMessage(sourceSessionId, { role: 'assistant', content: 'root answer' });
    await first.appendInternalEntry({
      sessionId: sourceSessionId,
      kind: 'permission_pending',
      content: 'approval needed',
      metadata: { toolName: 'bash' },
    });
    await first.appendUsage({
      sessionId: sourceSessionId,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    const forkSessionId = await first.forkSession({
      sourceSessionId,
      sessionId: 'session-fork',
    });

    assert.equal(forkSessionId, 'session-fork');
    assert.deepEqual(first.getMessages(forkSessionId), first.getMessages(sourceSessionId));
    assert.deepEqual(first.getLineageInfo(forkSessionId), {
      sessionId: 'session-fork',
      parentSessionId: 'session-root',
      rootSessionId: 'session-root',
      forkedFromMessageIndex: 2,
      createdAt: first.getLineageInfo(forkSessionId).createdAt,
    });
    assert.deepEqual(
      first.getEntryPath(forkSessionId).map((entry) => ({
        type: entry.type,
        sessionId: entry.sessionId,
        entryId: entry.entryId,
        parentEntryId: entry.parentEntryId,
      })),
      first.getEntryPath(sourceSessionId).map((entry) => ({
        type: entry.type,
        sessionId: forkSessionId,
        entryId: entry.entryId,
        parentEntryId: entry.parentEntryId,
      })),
    );
    assert.deepEqual(
      first.getEntryPath(forkSessionId).map((entry) => entry.type),
      ['message', 'message', 'message', 'internal', 'usage'],
    );
    assert.deepEqual(
      first.getActiveState(forkSessionId),
      buildSessionStateFromEntryPath(first.getEntryPath(forkSessionId)),
    );
    assert.deepEqual(first.getInternalEntries(forkSessionId), first.getInternalEntries(sourceSessionId));
    assert.deepEqual(first.getUsageInfo(forkSessionId), first.getUsageInfo(sourceSessionId));

    await first.appendMessage(forkSessionId, { role: 'user', content: 'fork task' });
    assert.deepEqual(
      first.getMessages(sourceSessionId).map((message) => message.content),
      ['system', 'root task', 'root answer'],
    );
    assert.deepEqual(
      first.getMessages(forkSessionId).map((message) => message.content),
      ['system', 'root task', 'root answer', 'fork task'],
    );

    const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
    const rawForkLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-fork.jsonl'),
      'utf-8',
    );
    assert.match(rawForkLog, /"parentSessionId":"session-root"/);
    assert.match(rawForkLog, /"rootSessionId":"session-root"/);
    assert.match(rawForkLog, /"forkedFromMessageIndex":2/);
    assert.match(rawForkLog, /"type":"internal"/);
    assert.match(rawForkLog, /"type":"usage"/);

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await second.loadSession(forkSessionId), true);
    assert.deepEqual(second.getMessages(forkSessionId), first.getMessages(forkSessionId));
    assert.deepEqual(second.getLineageInfo(forkSessionId), first.getLineageInfo(forkSessionId));
    assert.deepEqual(second.getInternalEntries(forkSessionId), first.getInternalEntries(forkSessionId));
    assert.deepEqual(second.getUsageInfo(forkSessionId), first.getUsageInfo(forkSessionId));

    const listed = await second.listSessions();
    const forkListItem = listed.find((session) => session.sessionId === forkSessionId);
    assert.equal(forkListItem?.parentSessionId, sourceSessionId);
    assert.equal(forkListItem?.rootSessionId, sourceSessionId);
    assert.equal(forkListItem?.forkedFromMessageIndex, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager forks from a specified leaf entry path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-fork-entry-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sourceSessionId = await manager.createSession('system', 'session-root');
    await manager.appendMessage(sourceSessionId, { role: 'user', content: 'first task' });
    const leafEntryId = manager
      .getEntryPath(sourceSessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'first task')
      ?.entryId;
    assert.ok(leafEntryId);
    await manager.appendMessage(sourceSessionId, { role: 'assistant', content: 'later answer' });

    const forkSessionId = await manager.forkSession({
      sourceSessionId,
      sessionId: 'session-fork',
      leafEntryId,
    });

    assert.deepEqual(
      manager.getMessages(forkSessionId).map((message) => message.content),
      ['system', 'first task'],
    );
    assert.deepEqual(
      manager.getEntryPath(forkSessionId).map((entry) => entry.entryId),
      manager.getEntryPath(sourceSessionId, leafEntryId).map((entry) => entry.entryId),
    );
    await assert.rejects(
      () => manager.forkSession({ sourceSessionId, sessionId: 'missing-entry-fork', leafEntryId: 'missing-entry' }),
      /Entry not found in session session-root: missing-entry/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager branches the active session to a specified entry path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-branch-entry-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await manager.createSession('system', 'session-root');
    await manager.appendMessage(sessionId, { role: 'user', content: 'first task' });
    const leafEntryId = manager
      .getEntryPath(sessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'first task')
      ?.entryId;
    assert.ok(leafEntryId);
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'later answer' });
    await manager.appendUsage({
      sessionId,
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    await manager.appendInternalEntry({
      sessionId,
      kind: 'permission_pending',
      content: 'abandoned branch pending permission',
    });
    const fromEntryId = manager.getEntryPath(sessionId).at(-1)?.entryId;
    assert.ok(fromEntryId);

    const summary = await manager.branchSession({ sessionId, leafEntryId });

    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task'],
    );
    assert.equal(summary.leafEntryId, leafEntryId);
    assert.ok(summary.branchEntryId);
    assert.equal(summary.fromEntryId, fromEntryId);
    assert.equal(summary.pathEntryCount, 2);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.targetEntry.messageRole, 'user');
    assert.equal(summary.targetEntry.preview, 'first task');
    assert.equal(summary.targetEntry.isActivePath, true);
    assert.equal(manager.getUsageInfo(sessionId).count, 0);
    assert.deepEqual(manager.getInternalEntries(sessionId), []);
    const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
    const rawLog = await fs.readFile(
      path.join(baseDir, workspaceKey, 'session-root.jsonl'),
      'utf-8',
    );
    const persistedEntries = rawLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        type: string;
        entryId: string;
        parentEntryId: string | null;
        targetEntryId?: string | null;
      });
    const leafEntry = persistedEntries.find((entry) => entry.type === 'leaf');
    const branchSummaryEntry = persistedEntries.find((entry) => entry.type === 'branch_summary');
    assert.ok(leafEntry?.entryId);
    assert.equal(leafEntry.parentEntryId, fromEntryId);
    assert.equal(leafEntry.targetEntryId, leafEntryId);
    assert.equal(branchSummaryEntry?.parentEntryId, leafEntryId);

    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch answer' });
    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    assert.deepEqual(
      manager.getEntryPath(sessionId).map((entry) => entry.type === 'message' ? entry.message.content : entry.type),
      ['system', 'first task', 'branch_summary', 'branch answer'],
    );
    assert.equal(manager.getUsageInfo(sessionId).count, 0);
    assert.deepEqual(manager.getInternalEntries(sessionId), []);
    const entryTree = manager.listEntryTree(sessionId);
    assert.equal(entryTree.length, 1);
    assert.equal(entryTree[0]?.entry.messageRole, 'system');
    assert.equal(entryTree[0]?.entry.isActivePath, true);
    assert.equal(entryTree[0]?.children[0]?.entry.messageRole, 'user');
    assert.equal(entryTree[0]?.children[0]?.entry.isActivePath, true);
    assert.equal(entryTree[0]?.children[0]?.children[0]?.entry.preview, 'later answer');
    assert.equal(entryTree[0]?.children[0]?.children[1]?.entry.type, 'branch_summary');
    assert.match(entryTree[0]?.children[0]?.children[1]?.entry.preview ?? '', /to=/);
    assert.equal(entryTree[0]?.children[0]?.children[1]?.children[0]?.entry.isActive, true);
    assert.equal(entryTree[0]?.children[0]?.children[1]?.children[0]?.entry.isActivePath, true);
    assert.equal(entryTree[0]?.children[0]?.children[0]?.entry.isActivePath, false);

    const reloaded = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await reloaded.loadSession(sessionId), true);
    assert.deepEqual(
      reloaded.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    await assert.rejects(
      () => manager.branchSession({ sessionId, leafEntryId: 'missing-entry' }),
      /Entry not found in session session-root: missing-entry/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager restores active leaf from durable leaf entries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-leaf-entry-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');
  const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
  const workspaceDataDir = path.join(baseDir, workspaceKey);

  try {
    await fs.mkdir(workspaceDataDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDataDir, 'leaf-session.jsonl'),
      [
        JSON.stringify({
          type: 'session_start',
          sessionId: 'leaf-session',
          workspaceDir: path.resolve(workspaceDir),
          createdAt: 100,
          schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'leaf-session',
          timestamp: 101,
          entryId: 'entry-system',
          parentEntryId: null,
          message: { role: 'system', content: 'system' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'leaf-session',
          timestamp: 102,
          entryId: 'entry-task',
          parentEntryId: 'entry-system',
          message: { role: 'user', content: 'task' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'leaf-session',
          timestamp: 103,
          entryId: 'entry-abandoned',
          parentEntryId: 'entry-task',
          message: { role: 'assistant', content: 'abandoned' },
        }),
        JSON.stringify({
          type: 'leaf',
          sessionId: 'leaf-session',
          timestamp: 104,
          entryId: 'entry-leaf',
          parentEntryId: 'entry-abandoned',
          targetEntryId: 'entry-task',
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await manager.loadSession('leaf-session'), true);
    assert.equal(manager.getEntryTreeInfo('leaf-session').activeEntryId, 'entry-task');
    assert.deepEqual(
      manager.getMessages('leaf-session').map((message) => message.content),
      ['system', 'task'],
    );

    await manager.appendMessage('leaf-session', { role: 'assistant', content: 'branch answer' });
    assert.deepEqual(
      manager.getEntryPath('leaf-session').map((entry) => entry.type === 'message' ? entry.message.content : entry.type),
      ['system', 'task', 'branch answer'],
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager branches to non-message leaf entries and appends from the active leaf', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-branch-non-message-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await manager.createSession('system', 'session-root');
    await manager.appendMessage(sessionId, { role: 'user', content: 'first task' });
    await manager.appendUsage({
      sessionId,
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const usageEntryId = manager
      .getEntryPath(sessionId)
      .find((entry) => entry.type === 'usage')
      ?.entryId;
    assert.ok(usageEntryId);
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'abandoned answer' });

    const summary = await manager.branchSession({ sessionId, leafEntryId: usageEntryId });

    assert.equal(summary.leafEntryId, usageEntryId);
    assert.ok(summary.branchEntryId);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.targetEntry.type, 'usage');
    assert.equal(manager.getUsageInfo(sessionId).count, 1);
    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task'],
    );

    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch answer' });
    assert.deepEqual(
      manager.getEntryPath(sessionId).map((entry) => entry.type === 'message' ? entry.message.content : entry.type),
      ['system', 'first task', 'usage', 'branch_summary', 'branch answer'],
    );

    const reloaded = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await reloaded.loadSession(sessionId), true);
    assert.deepEqual(
      reloaded.getEntryPath(sessionId).map((entry) => entry.type === 'message' ? entry.message.content : entry.type),
      ['system', 'first task', 'usage', 'branch_summary', 'branch answer'],
    );
    assert.equal(reloaded.getUsageInfo(sessionId).count, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager derives active state and compaction anchors from the active entry path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-active-state-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sessionId = await manager.createSession('system', 'session-active-state');
    await manager.appendMessage(sessionId, { role: 'user', content: 'first task' });
    await manager.appendUsage({
      sessionId,
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const leafEntryId = manager
      .getEntryPath(sessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'first task')
      ?.entryId;
    assert.ok(leafEntryId);
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'abandoned answer' });
    await manager.appendUsage({
      sessionId,
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    await manager.appendInternalEntry({
      sessionId,
      kind: 'permission_pending',
      content: 'abandoned permission',
    });

    await manager.branchSession({ sessionId, leafEntryId });
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch answer' });

    const activeState = manager.getActiveState(sessionId);
    const pathState = buildSessionStateFromEntryPath(manager.getEntryPath(sessionId));
    assert.deepEqual(
      activeState.messages.map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    assert.deepEqual(activeState, pathState);
    assert.deepEqual(activeState.messages, manager.getMessages(sessionId));
    assert.deepEqual(activeState.usage, manager.getUsageInfo(sessionId));
    assert.deepEqual(activeState.internalEntries, manager.getInternalEntries(sessionId));
    assert.equal(activeState.usage.count, 0);
    assert.equal(activeState.internalEntries.length, 0);

    activeState.messages.push({ role: 'user', content: 'mutated copy' });
    activeState.usage.total.total_tokens = 999;
    activeState.internalEntries.push({
      timestamp: 1,
      entryId: 'mutated-entry',
      parentEntryId: null,
      kind: 'mutated',
      content: 'copy only',
    });
    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    assert.equal(manager.getUsageInfo(sessionId).total.total_tokens, 0);
    assert.deepEqual(manager.getInternalEntries(sessionId), []);

    const branchAnswerEntryId = manager
      .getEntryPath(sessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'branch answer')
      ?.entryId;
    assert.ok(branchAnswerEntryId);
    await manager.appendCompaction({
      sessionId,
      summary: 'Branched work summary.',
      keepRecentMessages: 1,
    });
    assert.equal(manager.getCompactionInfo(sessionId).firstKeptEntryId, branchAnswerEntryId);
    assert.deepEqual(manager.getActiveState(sessionId), buildSessionStateFromEntryPath(manager.getEntryPath(sessionId)));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager clones sessions using current fork lineage semantics', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-clone-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const sourceSessionId = await first.createSession('system', 'session-root');
    await first.appendMessage(sourceSessionId, { role: 'user', content: 'source task' });

    const clonedSessionId = await first.cloneSession({
      sourceSessionId,
      sessionId: 'session-clone',
    });

    assert.equal(clonedSessionId, 'session-clone');
    assert.deepEqual(first.getMessages(clonedSessionId), first.getMessages(sourceSessionId));
    assert.deepEqual(first.getLineageInfo(clonedSessionId), {
      sessionId: 'session-clone',
      parentSessionId: 'session-root',
      rootSessionId: 'session-root',
      forkedFromMessageIndex: 1,
      createdAt: first.getLineageInfo(clonedSessionId).createdAt,
    });

    await first.appendMessage(clonedSessionId, { role: 'assistant', content: 'clone answer' });
    assert.deepEqual(
      first.getMessages(sourceSessionId).map((message) => message.content),
      ['system', 'source task'],
    );
    assert.deepEqual(
      first.getMessages(clonedSessionId).map((message) => message.content),
      ['system', 'source task', 'clone answer'],
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager lists sessions as a lineage tree', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-tree-list-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const rootSessionId = await manager.createSession('system', 'session-root');
    await manager.appendMessage(rootSessionId, { role: 'user', content: 'root task' });
    const forkSessionId = await manager.forkSession({
      sourceSessionId: rootSessionId,
      sessionId: 'session-fork',
    });
    await manager.appendMessage(forkSessionId, { role: 'user', content: 'fork task' });
    const cloneSessionId = await manager.cloneSession({
      sourceSessionId: forkSessionId,
      sessionId: 'session-clone',
    });

    const tree = await manager.listSessionTree();
    const rootChildren = await manager.listChildSessions(rootSessionId);
    const forkChildren = await manager.listChildSessions(forkSessionId);

    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.session.sessionId, rootSessionId);
    assert.equal(tree[0]?.children.length, 1);
    assert.equal(tree[0]?.children[0]?.session.sessionId, forkSessionId);
    assert.equal(tree[0]?.children[0]?.children.length, 1);
    assert.equal(tree[0]?.children[0]?.children[0]?.session.sessionId, cloneSessionId);
    assert.deepEqual(rootChildren.map((session) => session.sessionId), [forkSessionId]);
    assert.deepEqual(forkChildren.map((session) => session.sessionId), [cloneSessionId]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager exports and imports JSONL sessions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-import-export-'));
  const sourceWorkspaceDir = path.join(tempDir, 'source-workspace');
  const targetWorkspaceDir = path.join(tempDir, 'target-workspace');
  const sourceBaseDir = path.join(tempDir, 'source-sessions');
  const targetBaseDir = path.join(tempDir, 'target-sessions');
  const exportPath = path.join(tempDir, 'exported-session.jsonl');

  try {
    const source = new SessionManager({
      workspaceDir: sourceWorkspaceDir,
      mode: 'jsonl',
      baseDir: sourceBaseDir,
    });
    const sessionId = await source.createSession('system', 'session-export');
    await source.appendMessage(sessionId, { role: 'user', content: 'task' });
    await source.appendMessage(sessionId, { role: 'assistant', content: 'answer' });
    await source.appendUsage({
      sessionId,
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    const exported = await source.exportSession({ sessionId, outputPath: exportPath });
    assert.equal(exported.path, path.resolve(exportPath));
    assert.match(await fs.readFile(exportPath, 'utf-8'), /"sessionId":"session-export"/);

    const target = new SessionManager({
      workspaceDir: targetWorkspaceDir,
      mode: 'jsonl',
      baseDir: targetBaseDir,
    });
    const imported = await target.importSession({ inputPath: exportPath });

    assert.equal(imported.sessionId, sessionId);
    assert.equal(imported.sourcePath, path.resolve(exportPath));
    assert.ok(imported.destinationPath?.endsWith('session-export.jsonl'));
    assert.deepEqual(
      target.getMessages(sessionId).map((message) => message.content),
      ['system', 'task', 'answer'],
    );
    assert.equal(target.getUsageInfo(sessionId).total.total_tokens, 5);
    assert.deepEqual(
      target.getActiveState(sessionId),
      buildSessionStateFromEntryPath(target.getEntryPath(sessionId)),
    );
    assert.deepEqual(target.getSessionFormatInfo(sessionId), {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    });
    assert.equal(await target.loadLatestSession(), sessionId);

    const targetWorkspaceKey = encodeURIComponent(path.resolve(targetWorkspaceDir));
    const importedRawLog = await fs.readFile(
      path.join(targetBaseDir, targetWorkspaceKey, 'session-export.jsonl'),
      'utf-8',
    );
    assert.match(importedRawLog, new RegExp(`"schemaVersion":${CURRENT_SESSION_SCHEMA_VERSION}`));
    assert.match(importedRawLog, new RegExp(`"workspaceDir":"${escapeRegExp(path.resolve(targetWorkspaceDir))}"`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager rejects sessions without entry metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-old-lineage-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');
  const workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
  const workspaceDataDir = path.join(baseDir, workspaceKey);

  try {
    await fs.mkdir(workspaceDataDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDataDir, 'old-session.jsonl'),
      [
        JSON.stringify({
          type: 'session_start',
          sessionId: 'old-session',
          workspaceDir: path.resolve(workspaceDir),
          createdAt: 123,
          schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'old-session',
          timestamp: 124,
          message: { role: 'system', content: 'system' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const manager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await manager.loadSession('old-session'), false);
    assert.deepEqual(manager.getMessages('old-session'), []);
    assert.deepEqual(manager.getEntryPath('old-session'), []);
    assert.ok(manager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'session_log_missing_entry_metadata'
      && diagnostic.details?.['sessionId'] === 'old-session'
    )));
    assert.ok(manager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'session_load_invalid_log'
      && diagnostic.details?.['sessionId'] === 'old-session'
      && diagnostic.details?.['diagnosticCode'] === 'session_log_missing_entry_metadata'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager reports diagnostics for corrupt JSONL while loading valid entries', async () => {
  const storage = new MemorySessionStorage();
  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  const sessionId = await manager.createSession('system', 'corrupt-session');
  await manager.appendMessage(sessionId, { role: 'user', content: 'hello' });
  await storage.writeSessionLog(sessionId, `${await storage.readSessionLog(sessionId)}{"type":"message"\n`);
  const reloaded = new SessionManager({ workspaceDir: '/workspace', storage });

  assert.equal(await reloaded.loadSession(sessionId), true);
  assert.ok(reloaded.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_invalid_json'
    && diagnostic.details?.['sessionId'] === sessionId
  )));
});

test('SessionManager rejects invalid session entry payloads with diagnostics', async () => {
  const storage = new MemorySessionStorage();
  const sessionId = 'invalid-payload-session';
  await storage.writeSessionLog(sessionId, [
    JSON.stringify({
      type: 'session_start',
      sessionId,
      workspaceDir: '/workspace',
      createdAt: 123,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    }),
    JSON.stringify({
      type: 'message',
      sessionId,
      timestamp: 124,
      entryId: 'entry-system',
      parentEntryId: null,
      message: { role: 'system', content: 'system' },
    }),
    JSON.stringify({
      type: 'usage',
      sessionId,
      timestamp: 125,
      entryId: 'entry-bad-usage',
      parentEntryId: 'entry-system',
      source: 'assistant',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 'bad' },
    }),
    '',
  ].join('\n'));

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadSession(sessionId), true);
  assert.deepEqual(manager.getMessages(sessionId), [{ role: 'system', content: 'system' }]);
  assert.equal(manager.getUsageInfo(sessionId).count, 0);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_invalid_entry'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['reason'] === 'usage.usage.total_tokens must be a finite number'
  )));
});

test('SessionManager rejects unsupported session schema versions', async () => {
  const storage = new MemorySessionStorage();
  const sessionId = 'unsupported-schema-session';
  await storage.writeSessionLog(sessionId, [
    JSON.stringify({
      type: 'session_start',
      sessionId,
      workspaceDir: '/workspace',
      createdAt: 123,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
    }),
    JSON.stringify({
      type: 'message',
      sessionId,
      timestamp: 124,
      entryId: 'entry-system',
      parentEntryId: null,
      message: { role: 'system', content: 'system' },
    }),
    '',
  ].join('\n'));

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadSession(sessionId), false);
  assert.deepEqual(manager.getMessages(sessionId), []);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_unsupported_schema'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['schemaVersion'] === CURRENT_SESSION_SCHEMA_VERSION + 1
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_invalid_log'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['diagnosticCode'] === 'session_log_unsupported_schema'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_invalid_log'
    && diagnostic.message.includes(`schema version ${CURRENT_SESSION_SCHEMA_VERSION + 1}`)
    && diagnostic.message.includes(`supports schema version ${CURRENT_SESSION_SCHEMA_VERSION}`)
    && /Upgrade Eva or run a session migration/.test(diagnostic.message)
  )));
});

test('SessionManager reports actionable import errors for unsupported schema versions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-session-import-schema-'));
  const inputPath = path.join(tempDir, 'unsupported-schema.jsonl');
  const sessionId = 'unsupported-import-session';

  try {
    await fs.writeFile(inputPath, [
      JSON.stringify({
        type: 'session_start',
        sessionId,
        workspaceDir: '/source',
        createdAt: 123,
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
      }),
      JSON.stringify({
        type: 'message',
        sessionId,
        timestamp: 124,
        entryId: 'entry-system',
        parentEntryId: null,
        message: { role: 'system', content: 'system' },
      }),
      '',
    ].join('\n'), 'utf-8');

    const manager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
    await assert.rejects(
      () => manager.importSession({ inputPath }),
      new RegExp(
        'Imported session is not loadable: unsupported session schema version '
        + `${CURRENT_SESSION_SCHEMA_VERSION + 1}; this Eva build supports schema version `
        + `${CURRENT_SESSION_SCHEMA_VERSION}. Upgrade Eva or run a session migration`,
      ),
    );
    assert.ok(manager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'session_import_invalid_log'
      && diagnostic.details?.['sessionId'] === sessionId
      && diagnostic.details?.['diagnosticCode'] === 'session_log_unsupported_schema'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager rejects session logs without a valid session_start', async () => {
  const storage = new MemorySessionStorage();
  const sessionId = 'missing-start-session';
  await storage.writeSessionLog(sessionId, [
    JSON.stringify({
      type: 'message',
      sessionId,
      timestamp: 124,
      entryId: 'entry-system',
      parentEntryId: null,
      message: { role: 'system', content: 'system' },
    }),
    '',
  ].join('\n'));

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadSession(sessionId), false);
  assert.deepEqual(manager.getMessages(sessionId), []);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_missing_session_start'
    && diagnostic.details?.['sessionId'] === sessionId
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_invalid_log'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['diagnosticCode'] === 'session_log_missing_session_start'
  )));
});

test('SessionManager rejects broken active parent chains', async () => {
  const storage = new MemorySessionStorage();
  const sessionId = 'broken-parent-session';
  await storage.writeSessionLog(sessionId, [
    JSON.stringify({
      type: 'session_start',
      sessionId,
      workspaceDir: '/workspace',
      createdAt: 123,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    }),
    JSON.stringify({
      type: 'message',
      sessionId,
      timestamp: 124,
      entryId: 'entry-orphan',
      parentEntryId: 'missing-parent',
      message: { role: 'system', content: 'orphan system' },
    }),
    '',
  ].join('\n'));

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadSession(sessionId), false);
  assert.deepEqual(manager.getMessages(sessionId), []);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_broken_parent_chain'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['missingParentEntryId'] === 'missing-parent'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_invalid_log'
    && diagnostic.details?.['sessionId'] === sessionId
    && diagnostic.details?.['diagnosticCode'] === 'session_log_broken_parent_chain'
  )));
});

test('SessionManager falls back to a loadable session when latest manifest target is missing', async () => {
  const storage = new MemorySessionStorage();
  const writer = new SessionManager({ workspaceDir: '/workspace', storage });
  const fallbackSessionId = await writer.createSession('system', 'fallback-session');
  await writer.appendMessage(fallbackSessionId, { role: 'user', content: 'fallback task' });
  await storage.writeManifest({ latestSessionId: 'missing-session', updatedAt: 999 });

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadLatestSession(), fallbackSessionId);
  assert.deepEqual(
    manager.getMessages(fallbackSessionId).map((message) => message.content),
    ['system', 'fallback task'],
  );
  assert.equal((await storage.readManifest())?.latestSessionId, fallbackSessionId);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_failed'
    && diagnostic.details?.['sessionId'] === 'missing-session'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'latest_session_fallback_loaded'
    && diagnostic.details?.['sessionId'] === fallbackSessionId
    && diagnostic.details?.['failedLatestSessionId'] === 'missing-session'
  )));
});

test('SessionManager skips unloadable latest sessions during fallback selection', async () => {
  const storage = new MemorySessionStorage();
  const writer = new SessionManager({ workspaceDir: '/workspace', storage });
  const fallbackSessionId = await writer.createSession('system', 'fallback-schema-session');
  await writer.appendMessage(fallbackSessionId, { role: 'user', content: 'fallback task' });
  await storage.writeSessionLog('bad-latest-session', [
    JSON.stringify({
      type: 'session_start',
      sessionId: 'bad-latest-session',
      workspaceDir: '/workspace',
      createdAt: 123,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
    }),
    JSON.stringify({
      type: 'message',
      sessionId: 'bad-latest-session',
      timestamp: 124,
      entryId: 'entry-system',
      parentEntryId: null,
      message: { role: 'system', content: 'system' },
    }),
    '',
  ].join('\n'));
  await storage.writeManifest({ latestSessionId: 'bad-latest-session', updatedAt: 999 });

  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  assert.equal(await manager.loadLatestSession(), fallbackSessionId);
  assert.equal((await storage.readManifest())?.latestSessionId, fallbackSessionId);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_log_unsupported_schema'
    && diagnostic.details?.['sessionId'] === 'bad-latest-session'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'latest_session_fallback_loaded'
    && diagnostic.details?.['sessionId'] === fallbackSessionId
    && diagnostic.details?.['failedLatestSessionId'] === 'bad-latest-session'
  )));
});

test('SessionManager reports diagnostics when latest manifest points to an unloadable session', async () => {
  const storage = new MemorySessionStorage();
  const manager = new SessionManager({ workspaceDir: '/workspace', storage });
  await storage.writeManifest({ latestSessionId: 'missing-session', updatedAt: 123 });

  assert.equal(await manager.loadLatestSession(), null);
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'session_load_failed'
    && diagnostic.details?.['sessionId'] === 'missing-session'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'latest_session_load_failed'
    && diagnostic.details?.['sessionId'] === 'missing-session'
  )));
  assert.ok(manager.getDiagnostics().some((diagnostic) => (
    diagnostic.code === 'latest_session_fallback_unavailable'
    && diagnostic.details?.['sessionId'] === 'missing-session'
  )));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
