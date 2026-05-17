import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/core/session-manager.js';

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
        entryId?: string;
        parentEntryId?: string | null;
      });
    const messageEntries = entries.filter((entry) => entry.type === 'message');
    const usageEntry = entries.find((entry) => entry.type === 'usage');
    const internalEntry = entries.find((entry) => entry.type === 'internal');

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
        entryId?: string;
        parentEntryId?: string | null;
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

    const summary = manager.branchSession({ sessionId, leafEntryId });

    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task'],
    );
    assert.equal(summary.leafEntryId, leafEntryId);
    assert.equal(summary.pathEntryCount, 2);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.targetEntry.messageRole, 'user');
    assert.equal(summary.targetEntry.preview, 'first task');

    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch answer' });
    assert.deepEqual(
      manager.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    assert.deepEqual(
      manager.getEntryPath(sessionId).map((entry) => entry.type === 'message' ? entry.message.content : entry.type),
      ['system', 'first task', 'branch answer'],
    );
    const entryTree = manager.listEntryTree(sessionId);
    assert.equal(entryTree.length, 1);
    assert.equal(entryTree[0]?.entry.messageRole, 'system');
    assert.equal(entryTree[0]?.children[0]?.entry.messageRole, 'user');
    assert.deepEqual(
      entryTree[0]?.children[0]?.children.map((node) => node.entry.preview),
      ['later answer', 'branch answer'],
    );
    assert.equal(entryTree[0]?.children[0]?.children[1]?.entry.isActive, true);

    const reloaded = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    assert.equal(await reloaded.loadSession(sessionId), true);
    assert.deepEqual(
      reloaded.getMessages(sessionId).map((message) => message.content),
      ['system', 'first task', 'branch answer'],
    );
    assert.throws(
      () => manager.branchSession({ sessionId, leafEntryId: 'missing-entry' }),
      /Entry not found in session session-root: missing-entry/,
    );
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

    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.session.sessionId, rootSessionId);
    assert.equal(tree[0]?.children.length, 1);
    assert.equal(tree[0]?.children[0]?.session.sessionId, forkSessionId);
    assert.equal(tree[0]?.children[0]?.children.length, 1);
    assert.equal(tree[0]?.children[0]?.children[0]?.session.sessionId, cloneSessionId);
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
    assert.equal(await target.loadLatestSession(), sessionId);

    const targetWorkspaceKey = encodeURIComponent(path.resolve(targetWorkspaceDir));
    const importedRawLog = await fs.readFile(
      path.join(targetBaseDir, targetWorkspaceKey, 'session-export.jsonl'),
      'utf-8',
    );
    assert.match(importedRawLog, new RegExp(`"workspaceDir":"${escapeRegExp(path.resolve(targetWorkspaceDir))}"`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager treats old session_start entries as root sessions', async () => {
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
    assert.equal(await manager.loadSession('old-session'), true);
    assert.deepEqual(manager.getLineageInfo('old-session'), {
      sessionId: 'old-session',
      rootSessionId: 'old-session',
      createdAt: 123,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
