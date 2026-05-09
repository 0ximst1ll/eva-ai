import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeDiagnostic } from '../src/diagnostics.js';
import { renderRuntimeDiagnostics } from '../src/modes/cli-ui.js';

function captureConsoleLog(fn: () => void): string[] {
  const original = console.log;
  const output: string[] = [];
  console.log = (message?: unknown) => {
    output.push(String(message ?? ''));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return output;
}

test('renderRuntimeDiagnostics filters low-value info diagnostics by default', () => {
  const diagnostics: RuntimeDiagnostic[] = [
    {
      source: 'config',
      level: 'info',
      type: 'info',
      code: 'config_loaded',
      message: 'Loaded config',
    },
    {
      source: 'provider',
      level: 'info',
      type: 'info',
      code: 'retry_enabled',
      message: 'LLM retry enabled',
    },
    {
      source: 'resource',
      level: 'warning',
      type: 'warning',
      code: 'system_prompt_missing',
      message: 'System prompt not found',
    },
  ];

  const output = captureConsoleLog(() => renderRuntimeDiagnostics(diagnostics)).join('\n');

  assert.doesNotMatch(output, /Loaded config/);
  assert.match(output, /LLM retry enabled/);
  assert.match(output, /System prompt not found/);
});

test('renderRuntimeDiagnostics can render all diagnostics in verbose mode', () => {
  const diagnostics: RuntimeDiagnostic[] = [
    {
      source: 'config',
      level: 'info',
      type: 'info',
      code: 'config_loaded',
      message: 'Loaded config',
    },
  ];

  const output = captureConsoleLog(() => renderRuntimeDiagnostics(diagnostics, { verbose: true })).join('\n');

  assert.match(output, /Loaded config/);
});
