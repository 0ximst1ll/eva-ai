import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runRpcCli(input: string): Promise<ProcessResult> {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'eva-ai-rpc-cli-'));
  try {
    const configDir = path.join(homeDir, '.eva-ai', 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'config.yaml'),
      [
        'api_key: test-key',
        'api_base: https://example.invalid',
        'model: test-model',
        'provider: anthropic',
        'retry:',
        '  enabled: false',
        'tools:',
        '  enable_file_tools: false',
        '  enable_bash: false',
        '  enable_skills: false',
        '  enable_mcp: false',
        '',
      ].join('\n'),
    );
    const inputPath = path.join(homeDir, 'rpc-input.jsonl');
    const outputPath = path.join(homeDir, 'rpc-output.jsonl');
    const errorPath = path.join(homeDir, 'rpc-error.log');
    await writeFile(inputPath, input);

    // In this sandbox, stdout from a nested Node process can be dropped when captured
    // directly by a Node parent. Capture the CLI output through files, then let bash
    // relay the exact bytes back to the test process.
    const child = spawn(
      'bash',
      [
        '-lc',
        [
          '"$EVA_NODE" --import tsx src/cli.ts --rpc < "$EVA_RPC_INPUT" > "$EVA_RPC_OUTPUT" 2> "$EVA_RPC_ERROR"',
          'code=$?',
          'cat "$EVA_RPC_OUTPUT"',
          'cat "$EVA_RPC_ERROR" >&2',
          'exit "$code"',
        ].join('; '),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EVA_NODE: process.execPath,
          HOME: homeDir,
          USERPROFILE: homeDir,
          EVA_RPC_INPUT: inputPath,
          EVA_RPC_OUTPUT: outputPath,
          EVA_RPC_ERROR: errorPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    return { code, stdout, stderr };
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('CLI RPC mode keeps stdout as JSONL envelopes', async () => {
  const result = await runRpcCli(
    [
      '{bad json',
      JSON.stringify({ id: 'state-1', method: 'get_state' }),
      '',
    ].join('\n'),
  );

  assert.equal(result.code, 0, result.stderr);

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const envelopes = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(envelopes[0]?.['type'], 'error');
  assert.equal((envelopes[0]?.['error'] as Record<string, unknown>)['code'], 'invalid_json');
  assert.equal(envelopes[1]?.['id'], 'state-1');
  assert.equal(envelopes[1]?.['type'], 'response');

  const state = envelopes[1]?.['result'] as Record<string, unknown>;
  assert.equal(state['provider'], 'anthropic');
  assert.equal(state['model'], 'test-model');
});
