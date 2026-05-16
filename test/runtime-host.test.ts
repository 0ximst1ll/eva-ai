import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RuntimeHost } from '../src/core/runtime-host.js';

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
