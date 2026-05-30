import type { ToolExecutionContext, ToolMetadata } from '../tools/base.js';
import { isWorkspacePath } from '../tools/path-utils.js';
import type { BeforeToolCallContext } from './agent-loop.js';

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionMode = 'default' | 'read-only' | 'full-access';

export interface PermissionExecutionPolicy {
  allowOutsideWorkspace: boolean;
  allowNetwork: boolean;
  allowSystemResources: boolean;
  sandboxEnforced: false;
}

export interface ToolPermissionRuleResult {
  decision: ToolPermissionDecision;
  reason?: string;
  toolExecutionContext?: Partial<ToolExecutionContext>;
  executionPolicy: PermissionExecutionPolicy;
}

const BASE_EXECUTION_POLICY: PermissionExecutionPolicy = {
  allowOutsideWorkspace: false,
  allowNetwork: false,
  allowSystemResources: false,
  sandboxEnforced: false,
};

const PATH_ARG_KEYS = [
  'path',
  'file_path',
  'target_path',
  'directory',
  'cwd',
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|aria2c|ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|socat|ssh-keyscan)\b/i,
  /\bopenssl\s+s_client\b/i,
  /\bgit\s+(clone|pull|fetch|push|ls-remote|archive)\b/i,
  /\bgit\s+remote\s+(add|set-url)\b.*\b(https?:\/\/|ssh:\/\/|git@)/i,
  /\bgit\s+(submodule|lfs)\s+(update|pull|fetch|push|install)\b/i,
  /\b(gh|glab)\s+(repo|pr|issue|release|workflow|run|api|auth)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|dlx|create|exec|x|link)\b/i,
  /\b(corepack)\s+(enable|prepare|install)\b/i,
  /\b(npx|pnpx|yarnx|bunx|uvx)\b/i,
  /\b(python|python3|py)\s+-m\s+pip\s+install\b/i,
  /\b(pip|pip3|pipx)\s+install\b/i,
  /\buv\s+(add|sync|pip\s+install|tool\s+install)\b/i,
  /\b(poetry|pipenv|conda|mamba)\s+(add|install|update|sync|create)\b/i,
  /\b(gem|bundle)\s+(install|update|add)\b/i,
  /\b(cargo|rustup)\s+(install|fetch|update|add|toolchain\s+install|component\s+add)\b/i,
  /\bgo\s+(install|get|work\s+sync)\b/i,
  /\bgo\s+(mod\s+download|run\s+\S+@\S+)\b/i,
  /\bcomposer\s+(install|update|require)\b/i,
  /\b(dotnet|nuget)\s+(restore|add\s+package|tool\s+install|install)\b/i,
  /\b(swift|gradle|mvn)\s+(package\s+(resolve|update)|dependencies|dependency:go-offline|compile|test|package|install|verify)\b/i,
  /\b(docker|podman)\s+(pull|push|login|run|build|buildx\s+build|compose\s+(pull|build|up|run))\b/i,
  /\b(kubectl)\s+(get|logs|exec|port-forward|apply|delete|create|scale|rollout|cp)\b/i,
  /\bhelm\s+(repo\s+(add|update)|install|upgrade|pull|dependency\s+(build|update))\b/i,
  /\b(terraform|tofu)\s+(apply|destroy|init|plan|refresh|push|pull|import)\b/i,
  /\b(aws|gcloud|az|flyctl|vercel|netlify|wrangler|supabase|firebase)\b/i,
  /\b(apt|apt-get|apk|dnf|yum|pacman|brew|snap|flatpak)\s+(install|update|upgrade|add)\b/i,
];

const SENSITIVE_SYSTEM_COMMAND_PATTERNS = [
  /\b(sudo|doas|su)\b/i,
  /\b(systemctl|service|launchctl|sc|netsh|reg)\b/i,
  /\b(mkfs|mount|umount|fdisk|parted|dd)\b/i,
  /\b(rm|chmod|chown|chgrp|mv|cp)\b[^|;&\n]*\s\/(etc|usr|bin|sbin|var|lib|opt|boot|sys|proc|dev)\b/i,
];

export function resolveToolPermission({
  context,
  mode,
  workspaceDir,
}: {
  context: BeforeToolCallContext & { tool?: { name?: string; metadata?: ToolMetadata } };
  mode: PermissionMode;
  workspaceDir: string;
}): ToolPermissionRuleResult {
  const metadata = context.tool?.metadata;
  const toolName = context.tool?.name ?? context.toolCall.function.name;

  if (mode === 'full-access') {
    return {
      decision: 'allow',
      toolExecutionContext: { allowOutsideWorkspace: true },
      executionPolicy: createExecutionPolicy({
        allowOutsideWorkspace: true,
        allowNetwork: true,
        allowSystemResources: true,
      }),
    };
  }

  if (!metadata) {
    return {
      decision: mode === 'read-only' ? 'deny' : 'ask',
      reason: `Tool permission ${mode === 'read-only' ? 'denied' : 'required'}: missing metadata for ${toolName}`,
      executionPolicy: createExecutionPolicy(),
    };
  }

  const outsideWorkspacePath = findOutsideWorkspacePath(context.args, workspaceDir);
  if (outsideWorkspacePath) {
    const allowOutsideWorkspace = mode !== 'read-only';
    return {
      decision: mode === 'read-only' ? 'deny' : 'ask',
      reason: `Tool permission ${mode === 'read-only' ? 'denied' : 'required'}: ${toolName} targets `
        + `outside workspace (${outsideWorkspacePath})`,
      toolExecutionContext: allowOutsideWorkspace ? { allowOutsideWorkspace: true } : undefined,
      executionPolicy: createExecutionPolicy({ allowOutsideWorkspace }),
    };
  }

  if (mode === 'read-only') {
    if (metadata.isReadOnly) return { decision: 'allow', executionPolicy: createExecutionPolicy() };
    return {
      decision: 'deny',
      reason: `Tool execution denied by read-only permission mode: ${toolName}`,
      executionPolicy: createExecutionPolicy(),
    };
  }

  if (metadata.category === 'mcp' || metadata.source === 'mcp') {
    return {
      decision: 'ask',
      reason: `Tool permission required: ${toolName} may access external resources`,
      executionPolicy: createExecutionPolicy({ allowNetwork: true }),
    };
  }

  if (metadata.category === 'bash' && isLikelyNetworkCommand(context.args)) {
    return {
      decision: 'ask',
      reason: 'Tool permission required: bash command may access the network',
      executionPolicy: createExecutionPolicy({ allowNetwork: true }),
    };
  }

  if (metadata.category === 'bash' && isLikelySensitiveSystemCommand(context.args)) {
    return {
      decision: 'ask',
      reason: 'Tool permission required: bash command may modify system resources',
      executionPolicy: createExecutionPolicy({ allowSystemResources: true }),
    };
  }

  return { decision: 'allow', executionPolicy: createExecutionPolicy() };
}

export function isLikelyNetworkCommand(args: Record<string, unknown>): boolean {
  const command = args['command'];
  if (typeof command !== 'string') return false;
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function isLikelySensitiveSystemCommand(args: Record<string, unknown>): boolean {
  const command = args['command'];
  if (typeof command !== 'string') return false;
  return SENSITIVE_SYSTEM_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function createExecutionPolicy(
  overrides: Partial<Omit<PermissionExecutionPolicy, 'sandboxEnforced'>> = {},
): PermissionExecutionPolicy {
  return {
    ...BASE_EXECUTION_POLICY,
    ...overrides,
  };
}

function findOutsideWorkspacePath(args: Record<string, unknown>, workspaceDir: string): string | null {
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isWorkspacePath(workspaceDir, value)) return value;
  }
  return null;
}
