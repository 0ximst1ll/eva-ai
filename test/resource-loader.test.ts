import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ConfigData } from '../src/config.js';
import { createResourceLoader } from '../src/core/resource-loader.js';

function createConfig({
  systemPromptPath = 'system_prompt.md',
  enableSkills = false,
  skillsDir = './skills',
}: {
  systemPromptPath?: string;
  enableSkills?: boolean;
  skillsDir?: string;
} = {}): ConfigData {
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
      enableSkills,
      skillsDir,
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
      config: createConfig({ systemPromptPath: 'missing-system-prompt.md' }),
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
      config: createConfig({ systemPromptPath: 'missing-system-prompt.md' }),
    });

    assert.equal(loader.systemPromptPath, null);
    assert.match(loader.systemPrompt, /Eva AI/);
    assert.equal(loader.projectContext.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createResourceLoader loads skill resources from configured skills directory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-resource-loader-'));

  try {
    const skillsDir = path.join(tempDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'review'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'review', 'SKILL.md'),
      [
        '---',
        'name: code-review',
        'description: Review code changes for defects',
        'disable-model-invocation: true',
        '---',
        '',
        'Use a code-review stance.',
      ].join('\n'),
      'utf-8',
    );

    const loader = createResourceLoader({
      workspaceDir: tempDir,
      config: createConfig({
        systemPromptPath: 'missing-system-prompt.md',
        enableSkills: true,
        skillsDir: './skills',
      }),
    });

    assert.equal(loader.skills.length, 1);
    assert.equal(loader.skills[0]?.name, 'code-review');
    assert.equal(loader.skills[0]?.description, 'Review code changes for defects');
    assert.equal(loader.skills[0]?.disableModelInvocation, true);
    assert.ok(loader.skills[0]?.content.includes('Use a code-review stance.'));
    assert.ok(loader.diagnostics.some((diagnostic) => diagnostic.code === 'skills_loaded'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createResourceLoader reports invalid and duplicate skills without failing startup', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-resource-loader-'));

  try {
    const skillsDir = path.join(tempDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'alpha'), { recursive: true });
    await fs.mkdir(path.join(skillsDir, 'duplicate'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'alpha', 'SKILL.md'),
      ['---', 'name: alpha', 'description: Alpha skill', '---', '', 'Alpha body.'].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(skillsDir, 'duplicate', 'SKILL.md'),
      ['---', 'name: alpha', 'description: Duplicate alpha', '---', '', 'Duplicate body.'].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(skillsDir, 'broken.md'),
      ['---', 'name: broken', '---', '', 'Missing description.'].join('\n'),
      'utf-8',
    );

    const loader = createResourceLoader({
      workspaceDir: tempDir,
      config: createConfig({
        systemPromptPath: 'missing-system-prompt.md',
        enableSkills: true,
        skillsDir: './skills',
      }),
    });

    assert.deepEqual(loader.skills.map((skill) => skill.name), ['alpha']);
    assert.ok(loader.diagnostics.some((diagnostic) => diagnostic.code === 'skill_duplicate_name'));
    assert.ok(loader.diagnostics.some((diagnostic) => diagnostic.code === 'skill_missing_description'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
