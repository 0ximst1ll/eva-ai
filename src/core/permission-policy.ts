import type { ToolExecutionContext, ToolMetadata } from '../tools/base.js';
import { isWorkspacePath } from '../tools/path-utils.js';
import type { BeforeToolCallContext } from './agent-loop.js';

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionMode = 'default' | 'read-only' | 'full-access';

export interface ToolPermissionRuleResult {
  decision: ToolPermissionDecision;
  reason?: string;
  toolExecutionContext?: Partial<ToolExecutionContext>;
}

const PATH_ARG_KEYS = [
  'path',
  'file_path',
  'target_path',
  'directory',
  'cwd',
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|socat)\b/i,
  /\bgit\s+(clone|pull|fetch|push|ls-remote)\b/i,
  /\bgit\s+submodule\s+update\b.*\b(--init|--remote)\b/i,
  /\b(gh|glab)\s+(repo|pr|issue|release|workflow|run|api|auth)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|dlx|create)\b/i,
  /\bnpx\b/i,
  /\b(pip|pip3|pipx)\s+install\b/i,
  /\buv\s+(add|sync|pip\s+install|tool\s+install)\b/i,
  /\bpoetry\s+(add|install|update)\b/i,
  /\b(gem|cargo|go)\s+(install|get)\b/i,
  /\bgo\s+mod\s+download\b/i,
  /\bcomposer\s+(install|update|require)\b/i,
  /\b(docker|podman)\s+(pull|push|build|buildx|compose\s+(pull|build|up))\b/i,
  /\b(kubectl|helm|terraform|tofu)\s+(apply|destroy|init|plan|refresh|push|pull)\b/i,
  /\b(apt|apt-get|apk|dnf|yum|pacman|brew)\s+(install|update|upgrade|add)\b/i,
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
    return { decision: 'allow', toolExecutionContext: { allowOutsideWorkspace: true } };
  }

  if (!metadata) {
    return {
      decision: mode === 'read-only' ? 'deny' : 'ask',
      reason: `Tool permission ${mode === 'read-only' ? 'denied' : 'required'}: missing metadata for ${toolName}`,
    };
  }

  const outsideWorkspacePath = findOutsideWorkspacePath(context.args, workspaceDir);
  if (outsideWorkspacePath) {
    return {
      decision: mode === 'read-only' ? 'deny' : 'ask',
      reason: `Tool permission ${mode === 'read-only' ? 'denied' : 'required'}: ${toolName} targets `
        + `outside workspace (${outsideWorkspacePath})`,
      toolExecutionContext: mode === 'read-only' ? undefined : { allowOutsideWorkspace: true },
    };
  }

  if (mode === 'read-only') {
    if (metadata.isReadOnly) return { decision: 'allow' };
    return {
      decision: 'deny',
      reason: `Tool execution denied by read-only permission mode: ${toolName}`,
    };
  }

  if (metadata.category === 'mcp' || metadata.source === 'mcp') {
    return {
      decision: 'ask',
      reason: `Tool permission required: ${toolName} may access external resources`,
    };
  }

  if (metadata.category === 'bash' && isLikelyNetworkCommand(context.args)) {
    return {
      decision: 'ask',
      reason: 'Tool permission required: bash command may access the network',
    };
  }

  return { decision: 'allow' };
}

export function isLikelyNetworkCommand(args: Record<string, unknown>): boolean {
  const command = args['command'];
  if (typeof command !== 'string') return false;
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function findOutsideWorkspacePath(args: Record<string, unknown>, workspaceDir: string): string | null {
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isWorkspacePath(workspaceDir, value)) return value;
  }
  return null;
}
