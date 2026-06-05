import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntimeServices } from '../src/core/runtime-services.js';
import type { Tool } from '../src/tools/base.js';

async function writeConfig(
  dir: string,
  {
    contextWindowTokens,
    compactionEnabled,
    compactionReserveTokens,
    enabledTools,
    disabledTools,
  }: {
    contextWindowTokens?: number;
    compactionEnabled?: boolean;
    compactionReserveTokens?: number;
    enabledTools?: string[];
    disabledTools?: string[];
  } = {},
): Promise<string> {
  const configPath = path.join(dir, 'config.yaml');
  const agentConfig = [
    ...(contextWindowTokens ? [`context_window_tokens: ${contextWindowTokens}`] : []),
    ...(compactionEnabled === undefined && compactionReserveTokens === undefined
      ? []
      : [
          'compaction:',
          ...(compactionEnabled === undefined ? [] : [`  enabled: ${compactionEnabled}`]),
          ...(compactionReserveTokens ? [`  reserve_tokens: ${compactionReserveTokens}`] : []),
        ]),
  ];
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
      ...(enabledTools ? ['  enabled_tools:', ...enabledTools.map((tool) => `    - ${tool}`)] : []),
      ...(disabledTools ? ['  disabled_tools:', ...disabledTools.map((tool) => `    - ${tool}`)] : []),
    ].join('\n'),
    'utf-8',
  );
  return configPath;
}

test('createRuntimeServices builds workspace-bound services without creating an AgentSession', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));

  try {
    const configPath = await writeConfig(tempDir, {
      contextWindowTokens: 100000,
      compactionEnabled: true,
      compactionReserveTokens: 16000,
    });
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
    assert.equal(services.toolRegistry?.size, 0);
    assert.ok(services.resourceLoader);
    assert.equal(services.resourceLoader.projectContext.length, 0);
    assert.ok(services.contextBuilder);
    assert.equal(services.contextBuilder.projectContext.length, 0);
    assert.equal(services.contextBuilder.projectContextMaxChars, 20000);
    assert.ok(services.contextManager);
    assert.equal(services.contextManager.contextBuilder, services.contextBuilder);
    assert.ok(services.tokenCounter);
    assert.equal(services.config.agent.contextWindowTokens, 100000);
    assert.equal(services.config.agent.compaction.enabled, true);
    assert.equal(services.config.agent.compaction.reserveTokens, 16000);
    assert.ok(services.sessionManager);
    assert.ok(services.llmClient);
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'config_loaded'));
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.code === 'session_manager_ready'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createRuntimeServices passes active tools to ContextBuilder', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));
  const tool: Tool = {
    name: 'write',
    description: 'Write content to a file',
    promptSnippet: 'Create a new file or completely overwrite a file',
    promptGuidelines: ['Always provide both required arguments: path and complete content.'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute() {
      return { success: true, content: 'ok' };
    },
  };

  try {
    const configPath = await writeConfig(tempDir);
    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [tool],
    });

    assert.deepEqual(services.contextBuilder.tools.map((candidate) => candidate.name), ['write']);
    const result = services.contextBuilder.build({
      systemPrompt: 'system',
      llmMessages: [{ role: 'system', content: 'system' }],
    });
    assert.match(result.messages[0]?.content ?? '', /<tool name="write">/);
    assert.match(result.messages[0]?.content ?? '', /Required arguments: path, content/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createRuntimeServices applies governance to custom active tools before ContextBuilder', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));
  const visibleTool: Tool = {
    name: 'visible',
    description: 'Visible custom tool',
    promptSnippet: 'Visible prompt snippet',
    promptGuidelines: ['Use visible when requested.'],
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'mcp',
      sourceName: 'custom',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute() {
      return { success: true, content: 'ok' };
    },
  };
  const hiddenTool: Tool = {
    ...visibleTool,
    name: 'hidden',
    description: 'Hidden custom tool',
    promptSnippet: 'Hidden prompt snippet',
  };

  try {
    const configPath = await writeConfig(tempDir, { disabledTools: ['hidden'] });
    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [visibleTool, hiddenTool],
    });

    assert.deepEqual(services.tools.map((tool) => tool.name), ['visible']);
    assert.equal(services.toolRegistry?.has('visible'), true);
    assert.equal(services.toolRegistry?.has('hidden'), false);
    const result = services.contextBuilder.build({
      systemPrompt: 'system',
      llmMessages: [{ role: 'system', content: 'system' }],
    });
    const system = result.messages[0]?.content ?? '';
    assert.match(system, /<tool name="visible">/);
    assert.match(system, /Visible prompt snippet/);
    assert.doesNotMatch(system, /<tool name="hidden">/);
    assert.ok(services.diagnostics.some((diagnostic) => (
      diagnostic.code === 'tool_disabled'
      && diagnostic.details?.['toolName'] === 'hidden'
    )));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createRuntimeServices reports duplicate custom tools and keeps the first definition active', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-services-'));
  const firstTool: Tool = {
    name: 'duplicate',
    description: 'First custom tool',
    promptSnippet: 'First prompt snippet',
    parameters: { type: 'object' },
    async execute() {
      return { success: true, content: 'first' };
    },
  };
  const secondTool: Tool = {
    ...firstTool,
    description: 'Second custom tool',
    promptSnippet: 'Second prompt snippet',
  };

  try {
    const configPath = await writeConfig(tempDir);
    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [firstTool, secondTool],
    });

    assert.deepEqual(services.tools.map((tool) => tool.name), ['duplicate']);
    const result = services.contextBuilder.build({
      systemPrompt: 'system',
      llmMessages: [{ role: 'system', content: 'system' }],
    });
    const system = result.messages[0]?.content ?? '';
    assert.match(system, /First prompt snippet/);
    assert.doesNotMatch(system, /Second prompt snippet/);
    assert.ok(services.diagnostics.some((diagnostic) => (
      diagnostic.code === 'tool_duplicate_skipped'
      && diagnostic.details?.['toolName'] === 'duplicate'
    )));
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
