import { createInterface } from 'node:readline/promises';
import type { ToolConfirmationRequest, ToolPermissionDecision } from '../core/runtime.js';
import type { RuntimeHost } from '../core/runtime-host.js';
import type { AgentSessionEvent } from '../schema.js';

export type RpcMethod =
  | 'prompt'
  | 'get_state'
  | 'abort'
  | 'new_session'
  | 'resume_session'
  | 'fork_session'
  | 'clone_session'
  | 'branch_session'
  | 'approve_permission'
  | 'deny_permission';

type RpcPermissionMode = 'fail_closed' | 'request';

interface RpcPermissionPendingEvent {
  type: 'permission_pending';
  permission: RpcPermissionPending;
}

type RpcEvent = AgentSessionEvent | RpcPermissionPendingEvent;

interface RpcPermissionPending {
  permission_id: string;
  tool_call_id: string;
  tool_name: string;
  risk_level: string;
  source: string;
  category: string;
  is_read_only: boolean;
  requires_confirmation: boolean;
  reason: string;
  args_preview: string;
}

export interface RpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type RpcEnvelope =
  | { id: RpcRequest['id']; type: 'response'; result: unknown }
  | { id: RpcRequest['id']; type: 'event'; event: RpcEvent }
  | { id: RpcRequest['id']; type: 'error'; error: { code: string; message: string } };

export interface RpcModeOptions {
  host: RuntimeHost;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  setToolConfirmationHandler?: (handler: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined) => void;
}

export interface RpcState {
  activeAbortController: AbortController | null;
  permissionBroker?: RpcPermissionBroker | null;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 120000;
const MAX_PERMISSION_TIMEOUT_MS = 600000;
const ARGS_PREVIEW_MAX_CHARS = 2000;

export async function runRpcMode({
  host,
  input = process.stdin,
  output = process.stdout,
  setToolConfirmationHandler,
}: RpcModeOptions): Promise<void> {
  const state: RpcState = { activeAbortController: null };
  const readline = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  for await (const line of readline) {
    const task = handleRpcLine({ host, state, line, output, setToolConfirmationHandler }).catch((e) => {
      writeRpcError(output, null, 'internal_error', (e as Error).message);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }

  await Promise.allSettled(pending);
}

export async function handleRpcLine({
  host,
  state,
  line,
  output,
  setToolConfirmationHandler,
}: {
  host: RuntimeHost;
  state: RpcState;
  line: string;
  output: NodeJS.WritableStream;
  setToolConfirmationHandler?: RpcModeOptions['setToolConfirmationHandler'];
}): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: RpcRequest;
  try {
    request = JSON.parse(trimmed) as RpcRequest;
  } catch {
    writeEnvelope(output, {
      id: null,
      type: 'error',
      error: {
        code: 'invalid_json',
        message: 'Invalid JSON request',
      },
    });
    return;
  }

  await handleRpcRequest({ host, state, request, output, setToolConfirmationHandler });
}

export async function handleRpcRequest({
  host,
  state,
  request,
  output,
  setToolConfirmationHandler,
}: {
  host: RuntimeHost;
  state: RpcState;
  request: RpcRequest;
  output: NodeJS.WritableStream;
  setToolConfirmationHandler?: RpcModeOptions['setToolConfirmationHandler'];
}): Promise<void> {
  const id = request.id ?? null;
  const method = request.method;
  if (!method) {
    writeRpcError(output, id, 'invalid_request', 'Request method is required');
    return;
  }

  if (
    state.activeAbortController
    && method !== 'abort'
    && method !== 'get_state'
    && method !== 'approve_permission'
    && method !== 'deny_permission'
  ) {
    writeRpcError(output, id, 'run_in_progress', 'A prompt is already running');
    return;
  }

  try {
    switch (method as RpcMethod) {
      case 'get_state':
        writeEnvelope(output, { id, type: 'response', result: createState(host, state) });
        return;

      case 'new_session':
        await host.newSession();
        writeEnvelope(output, { id, type: 'response', result: createState(host, state) });
        return;

      case 'resume_session':
        await handleResumeSession({ host, id, params: request.params, output });
        return;

      case 'fork_session':
        await handleForkSession({ host, id, params: request.params, output, clone: false });
        return;

      case 'clone_session':
        await handleForkSession({ host, id, params: request.params, output, clone: true });
        return;

      case 'branch_session':
        handleBranchSession({ host, id, params: request.params, output });
        return;

      case 'abort':
        if (state.activeAbortController) {
          state.activeAbortController.abort();
          state.permissionBroker?.cancelAll('Run aborted');
          writeEnvelope(output, { id, type: 'response', result: { aborted: true } });
        } else {
          writeEnvelope(output, { id, type: 'response', result: { aborted: false } });
        }
        return;

      case 'prompt':
        await handlePrompt({ host, state, id, params: request.params, output, setToolConfirmationHandler });
        return;

      case 'approve_permission':
        handlePermissionDecision({ state, id, params: request.params, output, decision: 'allow' });
        return;

      case 'deny_permission':
        handlePermissionDecision({ state, id, params: request.params, output, decision: 'deny' });
        return;

      default:
        writeRpcError(output, id, 'unknown_method', `Unknown RPC method: ${method}`);
    }
  } catch (e) {
    writeRpcError(output, id, 'internal_error', (e as Error).message);
  }
}

async function handleResumeSession({
  host,
  id,
  params,
  output,
}: {
  host: RuntimeHost;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
}): Promise<void> {
  const sessionId = params?.['session_id'];
  if (typeof sessionId === 'string' && sessionId.trim()) {
    await host.switchSession(sessionId);
  } else {
    await host.resumeLatestSession();
  }
  writeEnvelope(output, { id, type: 'response', result: createState(host) });
}

async function handleForkSession({
  host,
  id,
  params,
  output,
  clone,
}: {
  host: RuntimeHost;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
  clone: boolean;
}): Promise<void> {
  const sessionId = parseOptionalStringParam(params, 'session_id');
  const leafEntryId = parseOptionalStringParam(params, 'leaf_entry_id');
  if (clone) {
    await host.cloneSession(sessionId, leafEntryId);
  } else {
    await host.forkSession(sessionId, leafEntryId);
  }
  writeEnvelope(output, { id, type: 'response', result: createState(host) });
}

function handleBranchSession({
  host,
  id,
  params,
  output,
}: {
  host: RuntimeHost;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
}): void {
  const leafEntryId = parseOptionalStringParam(params, 'leaf_entry_id');
  if (!leafEntryId) {
    writeRpcError(output, id, 'invalid_request', 'leaf_entry_id is required');
    return;
  }
  const branch = host.branchSession(leafEntryId);
  writeEnvelope(output, { id, type: 'response', result: { ...createState(host), branch } });
}

function handlePermissionDecision({
  state,
  id,
  params,
  output,
  decision,
}: {
  state: RpcState;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
  decision: ToolPermissionDecision;
}): void {
  const permissionId = params?.['permission_id'];
  if (typeof permissionId !== 'string' || !permissionId.trim()) {
    writeRpcError(output, id, 'invalid_request', 'permission_id is required');
    return;
  }

  if (!state.permissionBroker?.resolve(permissionId, decision)) {
    writeRpcError(output, id, 'unknown_permission', `Unknown or resolved permission: ${permissionId}`);
    return;
  }

  writeEnvelope(output, {
    id,
    type: 'response',
    result: {
      permission_id: permissionId,
      decision,
      resolved: true,
    },
  });
}

function parseOptionalStringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function handlePrompt({
  host,
  state,
  id,
  params,
  output,
  setToolConfirmationHandler,
}: {
  host: RuntimeHost;
  state: RpcState;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
  setToolConfirmationHandler?: RpcModeOptions['setToolConfirmationHandler'];
}): Promise<void> {
  if (state.activeAbortController) {
    writeRpcError(output, id, 'run_in_progress', 'A prompt is already running');
    return;
  }

  const prompt = params?.['prompt'];
  if (typeof prompt !== 'string' || !prompt.trim()) {
    writeRpcError(output, id, 'invalid_request', 'prompt params.prompt is required');
    return;
  }

  const abortController = new AbortController();
  const permissionMode = parsePermissionMode(params);
  const permissionBroker = permissionMode === 'request'
    ? new RpcPermissionBroker({
      host,
      id,
      output,
      timeoutMs: parsePermissionTimeoutMs(params),
    })
    : null;
  state.activeAbortController = abortController;
  state.permissionBroker = permissionBroker;
  if (permissionBroker) {
    if (!setToolConfirmationHandler) {
      state.activeAbortController = null;
      state.permissionBroker = null;
      writeRpcError(output, id, 'permission_unavailable', 'RPC permission request mode is not available');
      return;
    }
    setToolConfirmationHandler((request) => permissionBroker.requestPermission(request));
  }
  try {
    await host.session.addUserMessage(prompt);
    const finalContent = await host.session.run({
      signal: abortController.signal,
      onEvent(event) {
        writeEnvelope(output, { id, type: 'event', event });
      },
    });
    writeEnvelope(output, { id, type: 'response', result: { finalContent, state: createState(host, state) } });
  } finally {
    permissionBroker?.cancelAll('Prompt finished');
    state.activeAbortController = null;
    state.permissionBroker = null;
    if (permissionBroker) setToolConfirmationHandler?.(undefined);
  }
}

function parsePermissionMode(params?: Record<string, unknown>): RpcPermissionMode {
  return params?.['permission_mode'] === 'request' ? 'request' : 'fail_closed';
}

function parsePermissionTimeoutMs(params?: Record<string, unknown>): number {
  const timeoutMs = params?.['permission_timeout_ms'];
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_PERMISSION_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_PERMISSION_TIMEOUT_MS);
}

function createState(host: RuntimeHost, state?: RpcState): Record<string, unknown> {
  const permissionSummary = state?.permissionBroker?.summary() ?? { pendingCount: 0, latestPermissionId: null };
  return {
    sessionId: host.sessionId,
    messageCount: host.session.messages.length,
    usage: host.session.usage,
    compaction: host.session.compaction,
    stepGuard: {
      enabled: typeof host.session.maxSteps === 'number' && Number.isFinite(host.session.maxSteps) && host.session.maxSteps > 0,
      maxSteps: host.session.maxSteps ?? null,
    },
    provider: host.runtime.config.llm.provider,
    model: host.runtime.config.llm.model,
    permissions: permissionSummary,
    diagnostics: host.runtime.diagnostics.map((diagnostic) => ({
      source: diagnostic.source,
      level: diagnostic.level,
      code: diagnostic.code,
      message: diagnostic.message,
      details: diagnostic.details,
    })),
  };
}

interface PendingPermission {
  readonly resolve: (decision: ToolPermissionDecision) => void;
  readonly timeout: NodeJS.Timeout;
}

class RpcPermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private nextId = 1;
  private latestPermissionId: string | null = null;

  constructor(private readonly options: {
    host: RuntimeHost;
    id: RpcRequest['id'];
    output: NodeJS.WritableStream;
    timeoutMs: number;
  }) {}

  requestPermission(request: ToolConfirmationRequest): Promise<ToolPermissionDecision> {
    const permission = this.createPermission(request);
    this.latestPermissionId = permission.permission_id;
    this.appendInternalEntry(permission).catch(() => undefined);
    writeEnvelope(this.options.output, {
      id: this.options.id,
      type: 'event',
      event: {
        type: 'permission_pending',
        permission,
      },
    });

    return new Promise<ToolPermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.resolve(permission.permission_id, 'deny');
      }, this.options.timeoutMs);
      this.pending.set(permission.permission_id, { resolve, timeout });
    });
  }

  resolve(permissionId: string, decision: ToolPermissionDecision): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(permissionId);
    pending.resolve(decision);
    return true;
  }

  cancelAll(_reason: string): void {
    for (const permissionId of [...this.pending.keys()]) {
      this.resolve(permissionId, 'deny');
    }
  }

  summary(): { pendingCount: number; latestPermissionId: string | null } {
    return {
      pendingCount: this.pending.size,
      latestPermissionId: this.latestPermissionId,
    };
  }

  private createPermission(request: ToolConfirmationRequest): RpcPermissionPending {
    const permissionId = `perm_${this.nextId}`;
    this.nextId += 1;
    return {
      permission_id: permissionId,
      tool_call_id: request.toolCall.id,
      tool_name: request.tool.name,
      risk_level: request.metadata.riskLevel,
      source: request.metadata.source,
      category: request.metadata.category,
      is_read_only: request.metadata.isReadOnly,
      requires_confirmation: request.metadata.requiresConfirmation ?? false,
      reason: `Tool permission pending: approval required for ${request.tool.name}`,
      args_preview: serializeArgsPreview(request.args),
    };
  }

  private async appendInternalEntry(permission: RpcPermissionPending): Promise<void> {
    const sessionManager = this.options.host.runtime.sessionManager;
    await sessionManager.appendInternalEntry({
      sessionId: this.options.host.sessionId,
      kind: 'permission_pending',
      content: permission.reason,
      metadata: {
        permissionId: permission.permission_id,
        toolName: permission.tool_name,
        toolCallId: permission.tool_call_id,
        riskLevel: permission.risk_level,
        source: permission.source,
        category: permission.category,
        isReadOnly: permission.is_read_only,
        requiresConfirmation: permission.requires_confirmation,
      },
    });
  }
}

function serializeArgsPreview(args: Record<string, unknown>): string {
  let preview: string;
  try {
    preview = JSON.stringify(args);
  } catch {
    preview = '[unserializable arguments]';
  }
  if (preview.length <= ARGS_PREVIEW_MAX_CHARS) return preview;
  return `${preview.slice(0, ARGS_PREVIEW_MAX_CHARS)}... [truncated]`;
}

function writeRpcError(
  output: NodeJS.WritableStream,
  id: RpcRequest['id'],
  code: string,
  message: string,
): void {
  writeEnvelope(output, { id, type: 'error', error: { code, message } });
}

function writeEnvelope(output: NodeJS.WritableStream, envelope: RpcEnvelope): void {
  output.write(`${JSON.stringify(envelope)}\n`);
}
