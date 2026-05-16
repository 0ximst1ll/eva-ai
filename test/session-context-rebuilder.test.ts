import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { rebuildSessionContext } from '../src/core/session-context-rebuilder.js';
import { SessionManager } from '../src/core/session-manager.js';

test('SessionContextRebuilder rebuilds old flat JSONL sessions as root snapshots', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-context-rebuild-old-'));
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
          createdAt: 100,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'old-session',
          timestamp: 101,
          message: { role: 'system', content: 'system' },
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'old-session',
          timestamp: 102,
          message: { role: 'user', content: 'hello' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const sessionManager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const snapshot = await rebuildSessionContext({ sessionManager, sessionId: 'old-session' });

    assert.ok(snapshot);
    assert.equal(snapshot.strategy, 'flat_snapshot');
    assert.deepEqual(snapshot.messages.map((message) => message.content), ['system', 'hello']);
    assert.deepEqual(snapshot.lineage, {
      sessionId: 'old-session',
      rootSessionId: 'old-session',
      createdAt: 100,
    });
    assert.deepEqual(snapshot.branchPath, [{
      sessionId: 'old-session',
      rootSessionId: 'old-session',
    }]);
    assert.deepEqual(snapshot.entryTree, {
      sessionId: 'old-session',
      activeEntryId: undefined,
      entries: [],
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionContextRebuilder rebuilds messages from the active entry path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-context-rebuild-entry-path-'));
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

    const sessionManager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const snapshot = await rebuildSessionContext({ sessionManager, sessionId: 'branch-session' });

    assert.ok(snapshot);
    assert.equal(snapshot.strategy, 'entry_path');
    assert.deepEqual(snapshot.messages.map((message) => message.content), [
      'system',
      'root task',
      'branch task',
    ]);
    assert.equal(snapshot.entryTree.activeEntryId, 'entry-branch-task');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionContextRebuilder returns fork lineage and isolated fork messages', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-context-rebuild-fork-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const sessionManager = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const rootSessionId = await sessionManager.createSession('system', 'session-root');
    await sessionManager.appendMessage(rootSessionId, { role: 'user', content: 'root task' });
    await sessionManager.appendMessage(rootSessionId, { role: 'assistant', content: 'root answer' });
    const forkSessionId = await sessionManager.forkSession({
      sourceSessionId: rootSessionId,
      sessionId: 'session-fork',
    });
    await sessionManager.appendMessage(forkSessionId, { role: 'user', content: 'fork task' });

    const snapshot = await rebuildSessionContext({ sessionManager, sessionId: forkSessionId });

    assert.ok(snapshot);
    assert.equal(snapshot.strategy, 'entry_path');
    assert.deepEqual(snapshot.messages.map((message) => message.content), [
      'system',
      'root task',
      'root answer',
      'fork task',
    ]);
    assert.deepEqual(sessionManager.getMessages(rootSessionId).map((message) => message.content), [
      'system',
      'root task',
      'root answer',
    ]);
    assert.deepEqual(snapshot.branchPath, [
      {
        sessionId: rootSessionId,
        rootSessionId,
      },
      {
        sessionId: forkSessionId,
        parentSessionId: rootSessionId,
        rootSessionId,
        forkedFromMessageIndex: 2,
      },
    ]);
    assert.equal(snapshot.entryTree.entries.length, 4);
    const lastEntry = snapshot.entryTree.entries[snapshot.entryTree.entries.length - 1];
    assert.equal(lastEntry.parentEntryId, snapshot.entryTree.entries[2].entryId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionContextRebuilder includes compacted fork metadata and internal entries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-context-rebuild-compact-fork-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const baseDir = path.join(tempDir, 'sessions');

  try {
    const first = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const rootSessionId = await first.createSession('system', 'session-root');
    await first.appendMessage(rootSessionId, { role: 'user', content: 'first task' });
    await first.appendMessage(rootSessionId, { role: 'assistant', content: 'first answer' });
    await first.appendMessage(rootSessionId, { role: 'user', content: 'second task' });
    await first.appendMessage(rootSessionId, { role: 'assistant', content: 'second answer' });
    const forkSessionId = await first.forkSession({
      sourceSessionId: rootSessionId,
      sessionId: 'session-fork',
    });
    await first.appendMessage(forkSessionId, { role: 'user', content: 'fork task' });
    await first.appendUsage({
      sessionId: forkSessionId,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    await first.appendInternalEntry({
      sessionId: forkSessionId,
      kind: 'permission_pending',
      content: 'approval required',
      metadata: { toolName: 'bash' },
    });
    await first.appendCompaction({
      sessionId: forkSessionId,
      summary: 'Fork summary.',
      keepRecentMessages: 2,
    });

    const second = new SessionManager({ workspaceDir, mode: 'jsonl', baseDir });
    const snapshot = await rebuildSessionContext({ sessionManager: second, sessionId: forkSessionId });

    assert.ok(snapshot);
    assert.equal(snapshot.strategy, 'entry_path');
    assert.equal(snapshot.compaction.compacted, true);
    assert.equal(snapshot.compaction.summaryLength, 'Fork summary.'.length);
    assert.equal(snapshot.usage.count, 1);
    assert.equal(snapshot.usage.total.total_tokens, 12);
    assert.deepEqual(snapshot.internalEntries.map((entry) => entry.kind), ['permission_pending']);
    assert.deepEqual(snapshot.messages.map((message) => message.content), [
      'system',
      '<conversation_summary>\nThe previous conversation was compacted. Use this summary as context for continuing the task.\n\nFork summary.\n</conversation_summary>',
      'fork task',
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
