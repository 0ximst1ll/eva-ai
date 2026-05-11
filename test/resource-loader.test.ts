import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ConfigData } from '../src/config.js';
import { createResourceLoader } from '../src/core/resource-loader.js';

function createConfig(systemPromptPath = 'system_prompt.md'): ConfigData {
  return {
    llm: {
      apiKey: 'test-key',
      apiBase: 'https://api.test',
      model: 'test-model',
      provider: 'anthropic',
      retry: {
        enabled: false,
        maxRetries: 0,
        initialDelay: 1,
        maxDelay: 1,
        exponentialBase: 2,
      },
    },
    agent: {
      maxSteps: 3,
      workspaceDir: '.',
      systemPromptPath,
      projectContextMaxChars: 20000,
      contextWindowTokens: null,
      compaction: {
        enabled: false,
        reserveTokens: 16384,
      },
    },
    tools: {
      enableFileTools: false,
      enableBash: false,
      enableSkills: false,
      skillsDir: './skills',
      enableMcp: false,
      mcpConfigPath: 'mcp.json',
      enabledTools: [],
      disabledTools: [],
      disabledCategories: [],
      requireConfirmation: false,
      confirmRiskLevels: [],
      mcp: {
        connectTimeout: 1,
        executeTimeout: 1,
        sseReadTimeout: 1,
      },
    },
  };
}

test('createResourceLoader loads workspace AGENTS.md as project context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-resource-loader-'));

  try {
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '# Project Instructions\n', 'utf-8');
    const loader = createResourceLoader({
      workspaceDir: tempDir,
      config: createConfig('missing-system-prompt.md'),
    });

    assert.equal(loader.projectContext.length, 1);
    assert.equal(loader.projectContext[0]?.name, 'AGENTS.md');
    assert.equal(loader.projectContext[0]?.content, '# Project Instructions\n');
    assert.ok(loader.diagnostics.some((diagnostic) => diagnostic.code === 'project_context_loaded'));
    assert.ok(loader.diagnostics.some((diagnostic) => diagnostic.code === 'system_prompt_missing'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createResourceLoader uses default system prompt when configured prompt is missing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-resource-loader-'));

  try {
    const loader = createResourceLoader({
      workspaceDir: tempDir,
      config: createConfig('missing-system-prompt.md'),
    });

    assert.equal(loader.systemPromptPath, null);
    assert.match(loader.systemPrompt, /Eva AI/);
    assert.equal(loader.projectContext.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
