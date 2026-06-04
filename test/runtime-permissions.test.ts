import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  createToolGovernanceHook,
  isLikelyNetworkCommand,
  normalizeToolPermissionDecision,
  resolveToolPermission,
  type CreateRuntimeOptions,
  type PermissionMode,
} from '../src/core/runtime.js';
import type { ConfigData } from '../src/config.js';
import type { BeforeToolCallContext } from '../src/core/agent-loop.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { Tool } from '../src/tools/base.js';
import { WriteTool } from '../src/tools/write.js';

const writeTool: Tool = {
  name: 'write',
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

const readTool: Tool = {
  ...writeTool,
  name: 'read',
  metadata: {
    category: 'read',
    riskLevel: 'low',
    source: 'builtin',
    isReadOnly: true,
    isConcurrencySafe: true,
  },
};

const bashTool: Tool = {
  ...writeTool,
  name: 'bash',
  metadata: {
    category: 'bash',
    riskLevel: 'high',
    source: 'builtin',
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: true,
  },
};

function createConfig(permissionMode: PermissionMode = 'default'): ConfigData {
  return {
    tools: {
      permissionMode,
      requireConfirmation: true,
      confirmRiskLevels: ['high'],
    },
  } as ConfigData;
}

function createContext(tool: Tool, args: Record<string, unknown> = { path: 'file.txt' }): BeforeToolCallContext {
  return {
    tool,
    args,
    messages: [],
    toolCall: {
      id: 'call-1',
      type: 'function',
      function: {
        name: tool.name,
        arguments: args,
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

test('permission rule allows workspace writes in default mode', () => {
  const result = resolveToolPermission({
    context: createContext(writeTool, { path: 'file.txt' }),
    mode: 'default',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'allow');
});

test('permission rule asks for outside-workspace file access in default mode', () => {
  const result = resolveToolPermission({
    context: createContext(writeTool, { path: '../outside.txt' }),
    mode: 'default',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'ask');
  assert.equal(result.toolExecutionContext?.allowOutsideWorkspace, true);
  assert.deepEqual(result.executionPolicy, {
    allowOutsideWorkspace: true,
    allowNetwork: false,
    allowSystemResources: false,
    sandboxEnforced: false,
  });
  assert.match(result.reason ?? '', /outside workspace/);
});

test('permission rule asks for likely network bash commands in default mode', () => {
  const result = resolveToolPermission({
    context: createContext(bashTool, { command: 'curl https://example.com' }),
    mode: 'default',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'ask');
  assert.deepEqual(result.executionPolicy, {
    allowOutsideWorkspace: false,
    allowNetwork: true,
    allowSystemResources: false,
    sandboxEnforced: false,
  });
  assert.match(result.reason ?? '', /network/);
});

test('permission rule asks for remote git and package manager commands in default mode', () => {
  for (const command of [
    'git push origin development',
    'git fetch --all',
    'git remote add origin git@github.com:example/repo.git',
    'git lfs pull',
    'npm install',
    'npm exec eslint',
    'pnpm add typescript',
    'python -m pip install pytest',
    'conda install numpy',
    'yarn install',
    'corepack prepare pnpm@latest --activate',
    'uv pip install pytest',
    'cargo fetch',
    'go mod download',
    'dotnet restore',
    'docker compose pull',
    'kubectl get pods',
    'aws s3 ls',
    'terraform init',
    'apt-get update',
  ]) {
    const result = resolveToolPermission({
      context: createContext(bashTool, { command }),
      mode: 'default',
      workspaceDir: '/workspace',
    });

    assert.equal(result.decision, 'ask', command);
    assert.match(result.reason ?? '', /network/, command);
  }
});

test('permission rule asks for sensitive system bash commands in default mode', () => {
  for (const command of [
    'sudo systemctl restart docker',
    'systemctl restart cron',
    'rm -rf /etc/eva',
    'dd if=image.img of=/dev/sda',
  ]) {
    const result = resolveToolPermission({
      context: createContext(bashTool, { command }),
      mode: 'default',
      workspaceDir: '/workspace',
    });

    assert.equal(result.decision, 'ask', command);
    assert.deepEqual(result.executionPolicy, {
      allowOutsideWorkspace: false,
      allowNetwork: false,
      allowSystemResources: true,
      sandboxEnforced: false,
    }, command);
    assert.match(result.reason ?? '', /system resources/, command);
  }
});

test('permission rule does not treat local bash commands as network access', () => {
  for (const command of [
    'git status',
    'git remote add origin ../repo.git',
    'npm test',
    'cargo test',
    'docker ps',
    'ls -la',
    'cat package.json',
  ]) {
    assert.equal(isLikelyNetworkCommand({ command }), false, command);
    const result = resolveToolPermission({
      context: createContext(bashTool, { command }),
      mode: 'default',
      workspaceDir: '/workspace',
    });

    assert.equal(result.decision, 'allow', command);
  }
});

test('permission rule denies writes in read-only mode', () => {
  const result = resolveToolPermission({
    context: createContext(writeTool, { path: 'file.txt' }),
    mode: 'read-only',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'deny');
});

test('permission rule allows read-only tools in read-only mode', () => {
  const result = resolveToolPermission({
    context: createContext(readTool, { path: 'file.txt' }),
    mode: 'read-only',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'allow');
});

test('permission rule denies outside-workspace file access in read-only mode', () => {
  const result = resolveToolPermission({
    context: createContext(readTool, { path: '../outside.txt' }),
    mode: 'read-only',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.toolExecutionContext, undefined);
  assert.deepEqual(result.executionPolicy, {
    allowOutsideWorkspace: false,
    allowNetwork: false,
    allowSystemResources: false,
    sandboxEnforced: false,
  });
  assert.match(result.reason ?? '', /outside workspace/);
});

test('permission rule denies network and system bash commands in read-only mode', () => {
  for (const command of ['curl https://example.com', 'sudo systemctl restart docker']) {
    const result = resolveToolPermission({
      context: createContext(bashTool, { command }),
      mode: 'read-only',
      workspaceDir: '/workspace',
    });

    assert.equal(result.decision, 'deny', command);
    assert.equal(result.toolExecutionContext, undefined, command);
    assert.deepEqual(result.executionPolicy, {
      allowOutsideWorkspace: false,
      allowNetwork: false,
      allowSystemResources: false,
      sandboxEnforced: false,
    }, command);
  }
});

test('permission rule allows all Eva-level tool calls in full-access mode', () => {
  const result = resolveToolPermission({
    context: createContext(writeTool, { path: '../outside.txt' }),
    mode: 'full-access',
    workspaceDir: '/workspace',
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.toolExecutionContext?.allowOutsideWorkspace, true);
  assert.deepEqual(result.executionPolicy, {
    allowOutsideWorkspace: true,
    allowNetwork: true,
    allowSystemResources: true,
    sandboxEnforced: false,
  });
});

test('tool governance allows default workspace writes without confirmation', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'deny'),
  );

  assert.equal(await hook(createContext(writeTool, { path: 'file.txt' })), undefined);
});

test('tool governance fails closed for pending permissions', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'ask'),
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /approval required/);
});

test('tool governance records pending permissions as durable internal entries', async () => {
  const sessionManager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await sessionManager.createSession('system', 'session-permission');
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'ask'),
    { sessionManager, sessionId },
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  const entries = sessionManager.getInternalEntries(sessionId, 'permission_pending');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, result?.reason);
  assert.equal(entries[0]?.metadata?.['toolName'], 'write');
  assert.equal(entries[0]?.metadata?.['toolCallId'], 'call-1');
  assert.equal(entries[0]?.metadata?.['permissionMode'], 'default');
  assert.equal(entries[0]?.metadata?.['decision'], 'ask');
  assert.deepEqual(entries[0]?.metadata?.['executionPolicy'], {
    allowOutsideWorkspace: true,
    allowNetwork: false,
    allowSystemResources: false,
    sandboxEnforced: false,
  });
  assert.deepEqual(sessionManager.getMessages(sessionId), [{ role: 'system', content: 'system' }]);
});

test('tool governance fails closed when no confirmation handler is available', async () => {
  const hook = createToolGovernanceHook(createConfig(), createOptions());

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /no confirmation handler/);
});

test('tool governance records missing confirmation handlers as pending permissions', async () => {
  const sessionManager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await sessionManager.createSession('system', 'session-permission');
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(),
    { sessionManager, sessionId },
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  assert.equal(sessionManager.getInternalEntries(sessionId, 'permission_pending').length, 1);
});

test('tool governance passes outside-workspace execution context after approval', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => 'allow'),
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, undefined);
  assert.equal(result?.toolExecutionContext?.allowOutsideWorkspace, true);
});

test('tool governance denies rejected tool calls', async () => {
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => false),
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /Tool execution denied/);
});

test('tool governance records rejected tool calls as denied permissions', async () => {
  const sessionManager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await sessionManager.createSession('system', 'session-permission');
  const hook = createToolGovernanceHook(
    createConfig(),
    createOptions(() => false),
    { sessionManager, sessionId },
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, true);
  const entries = sessionManager.getInternalEntries(sessionId, 'permission_denied');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, result?.reason);
  assert.equal(entries[0]?.metadata?.['toolName'], 'write');
  assert.equal(entries[0]?.metadata?.['permissionMode'], 'default');
  assert.equal(entries[0]?.metadata?.['decision'], 'deny');
  assert.deepEqual(entries[0]?.metadata?.['executionPolicy'], {
    allowOutsideWorkspace: true,
    allowNetwork: false,
    allowSystemResources: false,
    sandboxEnforced: false,
  });
});

test('tool governance blocks writes in read-only mode', async () => {
  const hook = createToolGovernanceHook(
    createConfig('read-only'),
    createOptions(() => 'allow'),
  );

  const result = await hook(createContext(writeTool, { path: 'file.txt' }));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /read-only permission mode/);
});

test('tool governance records policy-denied tool calls as denied permissions', async () => {
  const sessionManager = new SessionManager({ workspaceDir: '/workspace', mode: 'memory' });
  const sessionId = await sessionManager.createSession('system', 'session-permission');
  const hook = createToolGovernanceHook(
    createConfig('read-only'),
    createOptions(() => 'allow'),
    { sessionManager, sessionId },
  );

  const result = await hook(createContext(writeTool, { path: 'file.txt' }));

  assert.equal(result?.block, true);
  const entries = sessionManager.getInternalEntries(sessionId, 'permission_denied');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, result?.reason);
  assert.equal(entries[0]?.metadata?.['toolName'], 'write');
  assert.equal(entries[0]?.metadata?.['permissionMode'], 'read-only');
  assert.equal(entries[0]?.metadata?.['decision'], 'deny');
});

test('tool governance allows all tools in full-access mode', async () => {
  const hook = createToolGovernanceHook(
    createConfig('full-access'),
    createOptions(() => 'deny'),
  );

  const result = await hook(createContext(writeTool, { path: '../outside.txt' }));

  assert.equal(result?.block, undefined);
  assert.equal(result?.toolExecutionContext?.allowOutsideWorkspace, true);
});

test('file tools require execution context to access outside-workspace paths', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-permission-tools-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  await fs.mkdir(workspaceDir);
  const outsidePath = path.join(tempDir, 'outside.txt');
  const tool = new WriteTool(workspaceDir);

  const blocked = await tool.execute({ path: '../outside.txt', content: 'blocked' });
  assert.equal(blocked.success, false);
  assert.match(blocked.error ?? '', /Path escapes workspace/);

  const allowed = await tool.execute(
    { path: '../outside.txt', content: 'allowed' },
    { allowOutsideWorkspace: true },
  );
  assert.equal(allowed.success, true);
  assert.equal(await fs.readFile(outsidePath, 'utf-8'), 'allowed');
});
