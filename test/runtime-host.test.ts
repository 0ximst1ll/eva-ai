import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RuntimeHost } from '../src/core/runtime-host.js';
import { CURRENT_SESSION_SCHEMA_VERSION } from '../src/core/session-manager.js';

async function writeConfig(dir: string): Promise<string> {
  const configPath = path.join(dir, 'config.yaml');
  await fs.writeFile(
    configPath,
    [
      'api_key: "test-key"',
      'provider: "anthropic"',
      'retry:',
      '  enabled: false',
      'tools:',
      '  enable_file_tools: false',
      '  enable_bash: false',
      '  require_confirmation: false',
    ].join('\n'),
    'utf-8',
  );
  return configPath;
}

test('RuntimeHost creates, resumes, and switches sessions through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const firstSessionId = host.sessionId;

    await host.newSession();
    const secondSessionId = host.sessionId;
    assert.notEqual(secondSessionId, firstSessionId);

    await host.switchSession(firstSessionId);
    assert.equal(host.sessionId, firstSessionId);

    await host.resumeLatestSession();
    assert.equal(host.sessionId, firstSessionId);

    await host.switchSession(secondSessionId);
    assert.equal(host.sessionId, secondSessionId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost falls back when latest manifest points to a missing session', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-latest-missing-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const writer = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const fallbackSessionId = writer.sessionId;
    await writer.session.addUserMessage('fallback task');

    const workspaceKey = encodeURIComponent(path.resolve(tempDir));
    await fs.writeFile(
      path.join(sessionBaseDir, workspaceKey, 'manifest.json'),
      JSON.stringify({ latestSessionId: 'missing-session', updatedAt: Date.now() }, null, 2),
      'utf-8',
    );

    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: false,
      tools: [],
    });

    assert.equal(host.sessionId, fallbackSessionId);
    assert.equal(host.session.messages[0]?.role, 'system');
    assert.deepEqual(
      host.session.messages.slice(1).map((message) => message.content),
      ['fallback task'],
    );
    assert.ok(host.runtime.sessionManager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'latest_session_fallback_loaded'
      && diagnostic.details?.['failedLatestSessionId'] === 'missing-session'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost creates a new session when latest is missing and no fallback exists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-latest-empty-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const workspaceKey = encodeURIComponent(path.resolve(tempDir));
    const workspaceDataDir = path.join(sessionBaseDir, workspaceKey);
    await fs.mkdir(workspaceDataDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDataDir, 'manifest.json'),
      JSON.stringify({ latestSessionId: 'missing-session', updatedAt: Date.now() }, null, 2),
      'utf-8',
    );

    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: false,
      tools: [],
    });

    assert.notEqual(host.sessionId, 'missing-session');
    assert.equal(host.session.messages[0]?.role, 'system');
    assert.ok(host.runtime.sessionManager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'latest_session_fallback_unavailable'
      && diagnostic.details?.['sessionId'] === 'missing-session'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost reports diagnostics when latest schema is unsupported before fallback', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-latest-schema-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const writer = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const fallbackSessionId = writer.sessionId;

    const workspaceKey = encodeURIComponent(path.resolve(tempDir));
    const workspaceDataDir = path.join(sessionBaseDir, workspaceKey);
    await fs.writeFile(
      path.join(workspaceDataDir, 'bad-latest.jsonl'),
      [
        JSON.stringify({
          type: 'session_start',
          sessionId: 'bad-latest',
          workspaceDir: path.resolve(tempDir),
          createdAt: 100,
          schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'bad-latest',
          timestamp: 101,
          entryId: 'entry-system',
          parentEntryId: null,
          message: { role: 'system', content: 'system' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(workspaceDataDir, 'manifest.json'),
      JSON.stringify({ latestSessionId: 'bad-latest', updatedAt: Date.now() }, null, 2),
      'utf-8',
    );

    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: false,
      tools: [],
    });

    assert.equal(host.sessionId, fallbackSessionId);
    assert.ok(host.runtime.sessionManager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'session_log_unsupported_schema'
      && diagnostic.details?.['sessionId'] === 'bad-latest'
    )));
    assert.ok(host.runtime.sessionManager.getDiagnostics().some((diagnostic) => (
      diagnostic.code === 'latest_session_fallback_loaded'
      && diagnostic.details?.['failedLatestSessionId'] === 'bad-latest'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost forks the active session through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-fork-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const sourceSessionId = host.sessionId;
    await host.session.addUserMessage('source task');
    const sourceMessages = host.session.messages.map((message) => message.content);

    await host.forkSession('forked-session');

    assert.equal(host.sessionId, 'forked-session');
    assert.deepEqual(
      host.session.messages.map((message) => message.content),
      sourceMessages,
    );
    assert.deepEqual(host.runtime.sessionManager.getLineageInfo(host.sessionId), {
      sessionId: 'forked-session',
      parentSessionId: sourceSessionId,
      rootSessionId: sourceSessionId,
      forkedFromMessageIndex: 1,
      createdAt: host.runtime.sessionManager.getLineageInfo(host.sessionId).createdAt,
    });

    await host.session.addUserMessage('fork task');
    await host.switchSession(sourceSessionId);
    assert.deepEqual(
      host.session.messages.map((message) => message.content),
      sourceMessages,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost forks from a specified entry path through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-fork-entry-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const sourceSessionId = host.sessionId;
    await host.session.addUserMessage('source task');
    const leafEntryId = host.runtime.sessionManager
      .getEntryPath(sourceSessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'source task')
      ?.entryId;
    assert.ok(leafEntryId);
    await host.session.addUserMessage('later task');

    await host.forkSession('forked-from-entry', leafEntryId);

    assert.equal(host.sessionId, 'forked-from-entry');
    assert.equal(host.session.messages.length, 2);
    assert.equal(host.session.messages[1]?.content, 'source task');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost branches the active session through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-branch-entry-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const sessionId = host.sessionId;
    await host.session.addUserMessage('source task');
    const leafEntryId = host.runtime.sessionManager
      .getEntryPath(sessionId)
      .find((entry) => entry.type === 'message' && entry.message.content === 'source task')
      ?.entryId;
    assert.ok(leafEntryId);
    await host.session.addUserMessage('later task');

    const summary = await host.branchSession(leafEntryId);

    assert.equal(host.sessionId, sessionId);
    assert.equal(host.session.messages.length, 2);
    assert.equal(host.session.messages[1]?.content, 'source task');
    assert.equal(summary.leafEntryId, leafEntryId);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.targetEntry.preview, 'source task');

    await host.session.addUserMessage('branch task');
    assert.equal(host.session.messages.at(-1)?.content, 'branch task');
    assert.deepEqual(
      host.runtime.sessionManager
        .getEntryPath(sessionId)
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message.content),
      [host.session.messages[0]?.content, 'source task', 'branch task'],
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost clones the active session through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-clone-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const sourceSessionId = host.sessionId;
    await host.session.addUserMessage('source task');
    const sourceMessages = host.session.messages.map((message) => message.content);

    await host.cloneSession('cloned-session');

    assert.equal(host.sessionId, 'cloned-session');
    assert.deepEqual(
      host.session.messages.map((message) => message.content),
      sourceMessages,
    );
    assert.deepEqual(host.runtime.sessionManager.getLineageInfo(host.sessionId), {
      sessionId: 'cloned-session',
      parentSessionId: sourceSessionId,
      rootSessionId: sourceSessionId,
      forkedFromMessageIndex: 1,
      createdAt: host.runtime.sessionManager.getLineageInfo(host.sessionId).createdAt,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost exports and imports sessions through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-import-export-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const exportPath = path.join(tempDir, 'runtime-session.jsonl');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const exportedSessionId = host.sessionId;
    await host.session.addUserMessage('exported task');

    const exportedPath = await host.exportSession(exportPath);
    assert.equal(exportedPath, path.resolve(exportPath));

    await host.newSession();
    assert.notEqual(host.sessionId, exportedSessionId);

    await host.importSession(exportPath);
    assert.equal(host.sessionId, exportedSessionId);
    assert.equal(host.session.messages[0]?.role, 'system');
    assert.equal(host.session.messages[1]?.content, 'exported task');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost keeps the active session when import fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-import-fail-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const importPath = path.join(tempDir, 'bad-import.jsonl');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const activeSessionId = host.sessionId;
    await host.session.addUserMessage('current task');
    const activeMessages = host.session.messages.map((message) => message.content);

    await fs.writeFile(importPath, [
      JSON.stringify({
        type: 'session_start',
        sessionId: 'bad-import',
        workspaceDir: path.resolve(tempDir),
        createdAt: 100,
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'bad-import',
        timestamp: 101,
        entryId: 'entry-system',
        parentEntryId: null,
        message: { role: 'system', content: 'system' },
      }),
      '',
    ].join('\n'), 'utf-8');

    await assert.rejects(
      () => host.importSession(importPath),
      /Imported session is not loadable: unsupported session schema version/,
    );

    const workspaceKey = encodeURIComponent(path.resolve(tempDir));
    const manifest = JSON.parse(
      await fs.readFile(path.join(sessionBaseDir, workspaceKey, 'manifest.json'), 'utf-8'),
    ) as { latestSessionId: string };
    assert.equal(host.sessionId, activeSessionId);
    assert.deepEqual(host.session.messages.map((message) => message.content), activeMessages);
    assert.equal(manifest.latestSessionId, activeSessionId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost switches to the parent session through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-parent-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const parentSessionId = host.sessionId;
    await host.forkSession('child-session');
    assert.equal(host.sessionId, 'child-session');

    const runtime = await host.switchToParentSession();

    assert.ok(runtime);
    assert.equal(host.sessionId, parentSessionId);
    assert.equal(await host.switchToParentSession(), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost switches to child sessions through the runtime boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-child-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: true,
      tools: [],
    });
    const parentSessionId = host.sessionId;
    await host.forkSession('child-session');
    assert.equal(host.sessionId, 'child-session');
    await host.switchToParentSession();
    assert.equal(host.sessionId, parentSessionId);

    assert.deepEqual(
      (await host.listChildSessions()).map((session) => session.sessionId),
      ['child-session'],
    );

    const runtime = await host.switchToChildSession();

    assert.ok(runtime);
    assert.equal(host.sessionId, 'child-session');
    assert.equal(await host.switchToChildSession(), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost resumes sessions using the active entry path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-entry-path-'));

  try {
    const configPath = await writeConfig(tempDir);
    const sessionBaseDir = path.join(tempDir, 'sessions');
    const workspaceKey = encodeURIComponent(path.resolve(tempDir));
    const workspaceDataDir = path.join(sessionBaseDir, workspaceKey);
    await fs.mkdir(workspaceDataDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDataDir, 'branch-session.jsonl'),
      [
        JSON.stringify({
          type: 'session_start',
          sessionId: 'branch-session',
          workspaceDir: path.resolve(tempDir),
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

    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'jsonl',
      sessionBaseDir,
      createNewSession: false,
      sessionId: 'branch-session',
      tools: [],
    });

    assert.deepEqual(
      host.session.messages.map((message) => message.content),
      ['system', 'root task', 'branch task'],
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeHost reloadResources keeps the active session and reloads AGENTS.md', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-'));

  try {
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const configPath = await writeConfig(tempDir);
    const host = await RuntimeHost.create({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      createNewSession: true,
      tools: [],
    });
    const sessionId = host.sessionId;

    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'new instructions', 'utf-8');
    const result = await host.reloadResources();

    assert.equal(host.sessionId, sessionId);
    assert.equal(result.resourceLoader.projectContext[0]?.content, 'new instructions');
    assert.equal(host.runtime.services.contextBuilder.projectContext[0]?.content, 'new instructions');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
