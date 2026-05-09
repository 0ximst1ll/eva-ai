import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntimeServices } from '../src/core/runtime-services.js';

async function writeConfig(dir: string): Promise<string> {
  const configPath = path.join(dir, 'config.yaml');
  await fs.writeFile(
    configPath,
    [
      'api_key: "test-key"',
      'provider: "anthropic"',
      'model: "test-model"',
      'retry:',
      '  enabled: false',
      'tools:',
      '  enable_file_tools: false',
      '  enable_bash: false',
      '  enable_note: false',
      '  enable_skills: false',
      '  enable_mcp: false',
      '  require_confirmation: false',
    ].join('\n'),
    'utf-8',
  );
  return configPath;
}

test('createRuntimeServices builds workspace-bound services without creating an AgentSession', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));

  try {
    const configPath = await writeConfig(tempDir);
    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [],
    });

    assert.equal(services.workspaceDir, path.resolve(tempDir));
    assert.equal(services.configPath, configPath);
    assert.equal(services.config.llm.model, 'test-model');
    assert.equal(services.tools.length, 0);
    assert.equal(services.toolRegistry, null);
    assert.ok(services.sessionManager);
    assert.ok(services.llmClient);
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'config_loaded'));
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'session_manager_ready'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
