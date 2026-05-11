import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntimeServices } from '../src/core/runtime-services.js';

async function writeConfig(
  dir: string,
  {
    contextWindowTokens,
  }: {
    contextWindowTokens?: number;
  } = {},
): Promise<string> {
  const configPath = path.join(dir, 'config.yaml');
  const agentConfig = contextWindowTokens ? [`context_window_tokens: ${contextWindowTokens}`] : [];
  await fs.writeFile(
    configPath,
    [
      'api_key: "test-key"',
      'provider: "anthropic"',
      'model: "test-model"',
      'retry:',
      '  enabled: false',
      ...agentConfig,
      'tools:',
      '  enable_file_tools: false',
      '  enable_bash: false',
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
    const configPath = await writeConfig(tempDir, { contextWindowTokens: 100000 });
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
    assert.ok(services.resourceLoader);
    assert.equal(services.resourceLoader.projectContext.length, 0);
    assert.ok(services.contextBuilder);
    assert.equal(services.contextBuilder.projectContext.length, 0);
    assert.equal(services.contextBuilder.projectContextMaxChars, 20000);
    assert.ok(services.contextManager);
    assert.equal(services.contextManager.contextBuilder, services.contextBuilder);
    assert.ok(services.tokenCounter);
    assert.equal(services.config.agent.contextWindowTokens, 100000);
    assert.ok(services.sessionManager);
    assert.ok(services.llmClient);
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'config_loaded'));
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'session_manager_ready'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('RuntimeServices reloadResources reloads project context without recreating sessions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));

  try {
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const configPath = await writeConfig(tempDir);
    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [],
    });

    assert.match(services.contextBuilder.projectContext[0]?.content ?? '', /old instructions/);

    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'new instructions', 'utf-8');
    const previousSessionManager = services.sessionManager;
    const result = services.reloadResources();

    assert.equal(services.sessionManager, previousSessionManager);
    assert.equal(result.resourceLoader.projectContext[0]?.content, 'new instructions');
    assert.equal(services.contextBuilder.projectContext[0]?.content, 'new instructions');
    assert.equal(services.contextManager.contextBuilder, services.contextBuilder);
    assert.equal(services.contextManager.contextBuilder.projectContext[0]?.content, 'new instructions');
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'resources_reloaded'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
