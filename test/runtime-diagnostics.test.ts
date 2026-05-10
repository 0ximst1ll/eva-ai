import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/core/runtime.js';
import type { RuntimeDiagnostic } from '../src/diagnostics.js';

async function writeConfig(
  dir: string,
  {
    enableSkills = false,
    enableMcp = false,
  }: {
    enableSkills?: boolean;
    enableMcp?: boolean;
  } = {},
): Promise<string> {
  const configPath = path.join(dir, 'config.yaml');
  await fs.writeFile(
    configPath,
    [
      'api_key: "test-key"',
      'provider: "anthropic"',
      'model: "test-model"',
      'system_prompt_path: "missing-system-prompt.md"',
      'retry:',
      '  enabled: false',
      'tools:',
      '  enable_file_tools: false',
      '  enable_bash: false',
      `  enable_skills: ${enableSkills}`,
      `  enable_mcp: ${enableMcp}`,
      '  require_confirmation: false',
    ].join('\n'),
    'utf-8',
  );
  return configPath;
}

function findDiagnostic(diagnostics: RuntimeDiagnostic[], code: string): RuntimeDiagnostic {
  const diagnostic = diagnostics.find((item) => item.code === code);
  assert.ok(diagnostic, `expected diagnostic ${code}`);
  return diagnostic;
}

test('createRuntime returns unified diagnostics for config, provider, tools, session, and resources', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-diagnostics-'));

  try {
    const configPath = await writeConfig(tempDir);
    const runtime = await createRuntime({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      createNewSession: true,
      tools: [],
    });

    assert.deepEqual(
      new Set(runtime.diagnostics.map((diagnostic) => diagnostic.source)),
      new Set(['config', 'provider', 'resource', 'context', 'tools', 'session']),
    );
    assert.equal(runtime.config.agent.maxSteps, null);

    assert.equal(findDiagnostic(runtime.diagnostics, 'config_loaded').level, 'info');
    assert.equal(findDiagnostic(runtime.diagnostics, 'provider_configured').source, 'provider');
    assert.equal(findDiagnostic(runtime.diagnostics, 'system_prompt_missing').level, 'warning');
    assert.equal(findDiagnostic(runtime.diagnostics, 'context_builder_ready').source, 'context');
    assert.equal(findDiagnostic(runtime.diagnostics, 'custom_tools_loaded').source, 'tools');
    assert.equal(findDiagnostic(runtime.diagnostics, 'session_created').source, 'session');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createRuntime reports configured extension resources that are not loaded yet', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-diagnostics-'));

  try {
    const configPath = await writeConfig(tempDir, {
      enableSkills: true,
      enableMcp: true,
    });
    const runtime = await createRuntime({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      createNewSession: true,
      tools: [],
    });

    assert.equal(findDiagnostic(runtime.diagnostics, 'skills_resource_not_loaded').level, 'warning');
    assert.equal(findDiagnostic(runtime.diagnostics, 'mcp_resource_not_loaded').type, 'warning');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
