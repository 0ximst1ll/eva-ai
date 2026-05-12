import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolGovernanceHook,
  normalizeToolPermissionDecision,
  type CreateRuntimeOptions,
} from '../src/core/runtime.js';
import type { ConfigData } from '../src/config.js';
import type { BeforeToolCallContext } from '../src/core/agent-loop.js';
import type { Tool } from '../src/tools/base.js';

const confirmingTool: Tool = {
  name: 'write_file',
  description: 'Write file',
  parameters: { type: 'object' },
  metadata: {
    category: 'write',
    riskLevel: 'high',
    source: 'builtin',
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: true,
  },
  async execute() {
    return { success: true, content: 'ok' };
  },
};

const lowRiskTool: Tool = {
  ...confirmingTool,
  name: 'read_file',
  metadata: {
    category: 'read',
    riskLevel: 'low',
    source: 'builtin',
    isReadOnly: true,
    isConcurrencySafe: true,
  },
};

function createConfig(requireConfirmation = true): ConfigData {
  return {
    tools: {
      requireConfirmation,
      confirmRiskLevels: ['high'],
    },
  } as ConfigData;
}

function createContext(tool: Tool): BeforeToolCallContext {
  return {
    tool,
    args: { path: 'file.txt' },
    messages: [],
    toolCall: {
      id: 'call-1',
      type: 'function',
      function: {
        name: tool.name,
        arguments: { path: 'file.txt' },
      },
    },
  };
}

function createOptions(
  confirmToolCall?: CreateRuntimeOptions['confirmToolCall'],
): CreateRuntimeOptions {
  return {
    workspaceDir: '/workspace',
    confirmToolCall,
  };
}

test('normalizeToolPermissionDecision keeps boolean confirmation handlers compatible', () => {
  assert.equal(normalizeToolPermissionDecision(true), 'allow');
  assert.equal(normalizeToolPermissionDecision(false), 'deny');
  assert.equal(normalizeToolPermissionDecision('ask'), 'ask');
});

test('tool governance allows explicitly approved tool calls', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'allow'),
  );

  assert.equal(await hook(createContext(confirmingTool)), undefined);
});

test('tool governance fails closed for pending permissions', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'ask'),
  );

  const result = await hook(createContext(confirmingTool));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /Tool permission pending/);
});

test('tool governance fails closed when no confirmation handler is available', async () => {
  const hook = createToolGovernanceHook(createConfig(), createOptions());

  const result = await hook(createContext(confirmingTool));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /no confirmation handler/);
});

test('tool governance denies rejected tool calls', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => false),
  );

  const result = await hook(createContext(confirmingTool));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /Tool execution denied/);
});

test('tool governance skips tools that do not require confirmation', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'ask'),
  );

  assert.equal(await hook(createContext(lowRiskTool)), undefined);
});
