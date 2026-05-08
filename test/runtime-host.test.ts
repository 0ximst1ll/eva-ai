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

