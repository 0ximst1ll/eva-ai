import { createInterface } from 'node:readline/promises';
import type { RuntimeHost } from '../core/runtime-host.js';
import type { AgentSessionEvent } from '../schema.js';

export type RpcMethod = 'prompt' | 'get_state' | 'abort' | 'new_session' | 'resume_session';

export interface RpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type RpcEnvelope =
  | { id: RpcRequest['id']; type: 'response'; result: unknown }
  | { id: RpcRequest['id']; type: 'event'; event: AgentSessionEvent }
  | { id: RpcRequest['id']; type: 'error'; error: { code: string; message: string } };

export interface RpcModeOptions {
  host: RuntimeHost;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface RpcState {
  activeAbortController: AbortController | null;
}

export async function runRpcMode({
  host,
  input = process.stdin,
  output = process.stdout,
}: RpcModeOptions): Promise<void> {
  const state: RpcState = { activeAbortController: null };
  const readline = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  for await (const line of readline) {
    const task = handleRpcLine({ host, state, line, output }).catch((e) => {
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
}: {
  host: RuntimeHost;
  state: RpcState;
  line: string;
  output: NodeJS.WritableStream;
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

  await handleRpcRequest({ host, state, request, output });
}

export async function handleRpcRequest({
  host,
  state,
  request,
  output,
}: {
  host: RuntimeHost;
  state: RpcState;
  request: RpcRequest;
  output: NodeJS.WritableStream;
}): Promise<void> {
  const id = request.id ?? null;
  const method = request.method;
  if (!method) {
    writeRpcError(output, id, 'invalid_request', 'Request method is required');
    return;
  }

  if (state.activeAbortController && method !== 'abort' && method !== 'get_state') {
    writeRpcError(output, id, 'run_in_progress', 'A prompt is already running');
    return;
  }

  try {
    switch (method as RpcMethod) {
      case 'get_state':
        writeEnvelope(output, { id, type: 'response', result: createState(host) });
        return;

      case 'new_session':
        await host.newSession();
        writeEnvelope(output, { id, type: 'response', result: createState(host) });
        return;

      case 'resume_session':
        await handleResumeSession({ host, id, params: request.params, output });
        return;

      case 'abort':
        if (state.activeAbortController) {
          state.activeAbortController.abort();
          writeEnvelope(output, { id, type: 'response', result: { aborted: true } });
        } else {
          writeEnvelope(output, { id, type: 'response', result: { aborted: false } });
        }
        return;

      case 'prompt':
        await handlePrompt({ host, state, id, params: request.params, output });
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

async function handlePrompt({
  host,
  state,
  id,
  params,
  output,
}: {
  host: RuntimeHost;
  state: RpcState;
  id: RpcRequest['id'];
  params?: Record<string, unknown>;
  output: NodeJS.WritableStream;
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
  state.activeAbortController = abortController;
  await host.session.addUserMessage(prompt);
  try {
    const finalContent = await host.session.run({
      signal: abortController.signal,
      onEvent(event) {
        writeEnvelope(output, { id, type: 'event', event });
      },
    });
    writeEnvelope(output, { id, type: 'response', result: { finalContent, state: createState(host) } });
  } finally {
    state.activeAbortController = null;
  }
}

function createState(host: RuntimeHost): Record<string, unknown> {
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
    diagnostics: host.runtime.diagnostics.map((diagnostic) => ({
      source: diagnostic.source,
      level: diagnostic.level,
      code: diagnostic.code,
      message: diagnostic.message,
      details: diagnostic.details,
    })),
  };
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
