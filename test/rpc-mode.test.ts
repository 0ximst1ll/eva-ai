import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRpcLine, handleRpcRequest } from '../src/modes/rpc-mode.js';
import type { ToolConfirmationRequest, ToolPermissionDecision } from '../src/core/runtime.js';
import type { RuntimeHost } from '../src/core/runtime-host.js';
import type { AgentSessionEvent, Message } from '../src/schema.js';

class JsonlOutput {
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  envelopes(): Array<Record<string, unknown>> {
    return this.chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function createHost(options: {
  run?: ({ onEvent }: { onEvent?: (event: AgentSessionEvent) => void }) => Promise<string>;
} = {}) {
  let sessionId = 'session-1';
  const messages: Message[] = [{ role: 'system', content: 'system' }];
  const internalEntries: Array<Record<string, unknown>> = [];
  let runCalls = 0;
  let addUserMessageCalls = 0;
  let newSessionCalls = 0;
  let resumeLatestSessionCalls = 0;
  const forkCalls: Array<{ sessionId?: string; leafEntryId?: string }> = [];
  const cloneCalls: Array<{ sessionId?: string; leafEntryId?: string }> = [];
  const branchCalls: string[] = [];
  const switchedSessions: string[] = [];

  const host = {
    get sessionId() {
      return sessionId;
    },
    get session() {
      return {
        messages,
        maxSteps: null,
        usage: {
          count: 0,
          total: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        },
        compaction: { compacted: false },
        async addUserMessage(content: string) {
          addUserMessageCalls += 1;
          messages.push({ role: 'user', content });
        },
        async run({ onEvent }: { onEvent?: (event: AgentSessionEvent) => void }) {
          runCalls += 1;
          if (options.run) {
            return options.run({ onEvent });
          }
          onEvent?.({ type: 'agent_start' });
          onEvent?.({
            type: 'message_end',
            step: 1,
            elapsedMs: 5,
            totalElapsedMs: 5,
            response: {
              content: 'done',
              finish_reason: 'stop',
            },
          });
          onEvent?.({ type: 'agent_end', messages, finalContent: 'done' });
          messages.push({ role: 'assistant', content: 'done' });
          return 'done';
        },
      };
    },
    get runtime() {
      return {
        config: {
          llm: {
            provider: 'anthropic',
            model: 'test-model',
          },
        },
        diagnostics: [],
        sessionManager: {
          async appendInternalEntry(entry: Record<string, unknown>) {
            internalEntries.push(entry);
            return { timestamp: Date.now(), ...entry };
          },
        },
      };
    },
    async newSession() {
      newSessionCalls += 1;
      sessionId = 'session-new';
      messages.splice(0, messages.length, { role: 'system', content: 'system' });
    },
    async resumeLatestSession() {
      resumeLatestSessionCalls += 1;
      sessionId = 'session-latest';
    },
    async switchSession(nextSessionId: string) {
      switchedSessions.push(nextSessionId);
      sessionId = nextSessionId;
    },
    async forkSession(nextSessionId?: string, leafEntryId?: string) {
      forkCalls.push({ sessionId: nextSessionId, leafEntryId });
      sessionId = nextSessionId ?? 'session-fork';
    },
    async cloneSession(nextSessionId?: string, leafEntryId?: string) {
      cloneCalls.push({ sessionId: nextSessionId, leafEntryId });
      sessionId = nextSessionId ?? 'session-clone';
    },
    branchSession(leafEntryId: string) {
      branchCalls.push(leafEntryId);
      return {
        sessionId,
        leafEntryId,
        pathEntryCount: 4,
        messageCount: messages.length,
        targetEntry: {
          entryId: leafEntryId,
          parentEntryId: 'entry-2',
          type: 'message',
          timestamp: Date.parse('2026-05-08T00:00:03.000Z'),
          isActive: true,
          messageIndex: messages.length - 1,
          messageRole: 'assistant',
          preview: 'branch target',
        },
      };
    },
  } as unknown as RuntimeHost;

  return {
    host,
    stats: {
      get runCalls() { return runCalls; },
      get addUserMessageCalls() { return addUserMessageCalls; },
      get newSessionCalls() { return newSessionCalls; },
      get resumeLatestSessionCalls() { return resumeLatestSessionCalls; },
      forkCalls,
      cloneCalls,
      branchCalls,
      switchedSessions,
      internalEntries,
    },
  };
}

function createState() {
  return { activeAbortController: null };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

test('RPC returns structured error for invalid JSON and unknown method', async () => {
  const { host } = createHost();
  const output = new JsonlOutput();

  await handleRpcLine({
    host,
    state: createState(),
    line: '{bad json',
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: '2', method: 'missing' },
    output: output as unknown as NodeJS.WritableStream,
  });

  const envelopes = output.envelopes();
  assert.equal(envelopes[0]?.['type'], 'error');
  assert.deepEqual((envelopes[0]?.['error'] as Record<string, unknown>)['code'], 'invalid_json');
  assert.equal(envelopes[1]?.['type'], 'error');
  assert.deepEqual((envelopes[1]?.['error'] as Record<string, unknown>)['code'], 'unknown_method');
});

test('RPC get_state returns session and runtime state without running the agent', async () => {
  const { host, stats } = createHost();
  const output = new JsonlOutput();

  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'state-1', method: 'get_state' },
    output: output as unknown as NodeJS.WritableStream,
  });

  const envelope = output.envelopes()[0]!;
  const result = envelope['result'] as Record<string, unknown>;
  assert.equal(envelope['id'], 'state-1');
  assert.equal(envelope['type'], 'response');
  assert.equal(result['sessionId'], 'session-1');
  assert.equal(result['messageCount'], 1);
  assert.equal(result['provider'], 'anthropic');
  assert.equal(stats.runCalls, 0);
});

test('RPC prompt emits session events and final response', async () => {
  const { host, stats } = createHost();
  const output = new JsonlOutput();

  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'prompt-1', method: 'prompt', params: { prompt: 'hello' } },
    output: output as unknown as NodeJS.WritableStream,
  });

  const envelopes = output.envelopes();
  assert.deepEqual(envelopes.map((envelope) => envelope['type']), ['event', 'event', 'event', 'response']);
  assert.equal((envelopes[0]?.['event'] as Record<string, unknown>)['type'], 'agent_start');
  assert.equal((envelopes[3]?.['result'] as Record<string, unknown>)['finalContent'], 'done');
  assert.equal(stats.addUserMessageCalls, 1);
  assert.equal(stats.runCalls, 1);
});

test('RPC session commands use RuntimeHost session operations', async () => {
  const { host, stats } = createHost();
  const output = new JsonlOutput();

  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'new', method: 'new_session' },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'resume', method: 'resume_session' },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'switch', method: 'resume_session', params: { session_id: 'session-target' } },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: {
      id: 'fork',
      method: 'fork_session',
      params: { session_id: 'session-fork', leaf_entry_id: 'entry-1' },
    },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: {
      id: 'clone',
      method: 'clone_session',
      params: { session_id: 'session-clone', leaf_entry_id: 'entry-2' },
    },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'branch', method: 'branch_session', params: { leaf_entry_id: 'entry-3' } },
    output: output as unknown as NodeJS.WritableStream,
  });

  assert.equal(stats.newSessionCalls, 1);
  assert.equal(stats.resumeLatestSessionCalls, 1);
  assert.deepEqual(stats.switchedSessions, ['session-target']);
  assert.deepEqual(stats.forkCalls, [{ sessionId: 'session-fork', leafEntryId: 'entry-1' }]);
  assert.deepEqual(stats.cloneCalls, [{ sessionId: 'session-clone', leafEntryId: 'entry-2' }]);
  assert.deepEqual(stats.branchCalls, ['entry-3']);
  assert.deepEqual((output.envelopes().at(-1)?.['result'] as Record<string, unknown>)['branch'], {
    sessionId: 'session-clone',
    leafEntryId: 'entry-3',
    pathEntryCount: 4,
    messageCount: 1,
    targetEntry: {
      entryId: 'entry-3',
      parentEntryId: 'entry-2',
      type: 'message',
      timestamp: Date.parse('2026-05-08T00:00:03.000Z'),
      isActive: true,
      messageIndex: 0,
      messageRole: 'assistant',
      preview: 'branch target',
    },
  });
  assert.deepEqual(
    output.envelopes().map((envelope) => envelope['type']),
    ['response', 'response', 'response', 'response', 'response', 'response'],
  );
});

test('RPC branch_session requires leaf_entry_id', async () => {
  const { host, stats } = createHost();
  const output = new JsonlOutput();

  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'branch-missing', method: 'branch_session' },
    output: output as unknown as NodeJS.WritableStream,
  });

  const envelope = output.envelopes()[0]!;
  assert.equal(envelope['type'], 'error');
  assert.equal((envelope['error'] as Record<string, unknown>)['code'], 'invalid_request');
  assert.deepEqual(stats.branchCalls, []);
});

test('RPC abort reports whether an active run exists', async () => {
  const { host } = createHost();
  const output = new JsonlOutput();
  const activeAbortController = new AbortController();

  await handleRpcRequest({
    host,
    state: { activeAbortController },
    request: { id: 'abort-1', method: 'abort' },
    output: output as unknown as NodeJS.WritableStream,
  });
  await handleRpcRequest({
    host,
    state: createState(),
    request: { id: 'abort-2', method: 'abort' },
    output: output as unknown as NodeJS.WritableStream,
  });

  assert.equal(activeAbortController.signal.aborted, true);
  assert.deepEqual(
    output.envelopes().map((envelope) => (envelope['result'] as Record<string, unknown>)['aborted']),
    [true, false],
  );
});

test('RPC permission request mode emits pending event and approval resumes prompt', async () => {
  let confirmationHandler: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined;
  const { host, stats } = createHost({
    async run({ onEvent }) {
      onEvent?.({ type: 'agent_start' });
      assert.ok(confirmationHandler);
      const decision = await confirmationHandler({
        toolCall: {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: { path: 'file.txt', content: 'hello' },
          },
        },
        tool: {
          name: 'write_file',
          description: 'Write file',
          parameters: {},
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
        },
        args: { path: 'file.txt', content: 'hello' },
        metadata: {
          category: 'write',
          riskLevel: 'high',
          source: 'builtin',
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresConfirmation: true,
        },
      });
      onEvent?.({
        type: 'tool_result',
        result: {
          toolCallId: 'call-1',
          toolName: 'write_file',
          success: decision === 'allow',
          content: decision,
        },
      });
      return `decision:${decision}`;
    },
  });
  const output = new JsonlOutput();
  const state = createState();

  const promptTask = handleRpcRequest({
    host,
    state,
    request: {
      id: 'prompt-approve',
      method: 'prompt',
      params: {
        prompt: 'please write',
        permission_mode: 'request',
        permission_timeout_ms: 10000,
      },
    },
    output: output as unknown as NodeJS.WritableStream,
    setToolConfirmationHandler(handler) {
      confirmationHandler = handler;
    },
  });

  await waitFor(() => output.envelopes().some((envelope) => {
    const event = envelope['event'] as Record<string, unknown> | undefined;
    return event?.['type'] === 'permission_pending';
  }));

  const permissionEnvelope = output.envelopes().find((envelope) => {
    const event = envelope['event'] as Record<string, unknown> | undefined;
    return event?.['type'] === 'permission_pending';
  })!;
  const permissionEvent = permissionEnvelope['event'] as Record<string, unknown>;
  const permission = permissionEvent['permission'] as Record<string, unknown>;
  assert.equal(permission['tool_name'], 'write_file');
  assert.equal(permission['tool_call_id'], 'call-1');
  assert.equal(permission['risk_level'], 'high');
  assert.match(String(permission['args_preview']), /file\.txt/);

  await handleRpcRequest({
    host,
    state,
    request: { id: 'state-pending', method: 'get_state' },
    output: output as unknown as NodeJS.WritableStream,
  });

  await handleRpcRequest({
    host,
    state,
    request: {
      id: 'approve-1',
      method: 'approve_permission',
      params: { permission_id: permission['permission_id'] },
    },
    output: output as unknown as NodeJS.WritableStream,
  });
  await promptTask;

  const envelopes = output.envelopes();
  const stateResponse = envelopes.find((envelope) => envelope['id'] === 'state-pending')!;
  const approveResponse = envelopes.find((envelope) => envelope['id'] === 'approve-1')!;
  const finalResponse = envelopes.find((envelope) => envelope['id'] === 'prompt-approve' && envelope['type'] === 'response')!;
  const permissions = (stateResponse['result'] as Record<string, unknown>)['permissions'] as Record<string, unknown>;
  assert.equal(permissions['pendingCount'], 1);
  assert.equal(permissions['latestPermissionId'], permission['permission_id']);
  assert.equal((approveResponse['result'] as Record<string, unknown>)['decision'], 'allow');
  assert.equal((finalResponse['result'] as Record<string, unknown>)['finalContent'], 'decision:allow');
  assert.equal(confirmationHandler, undefined);
  assert.equal(stats.internalEntries.length, 1);
  assert.equal((stats.internalEntries[0]?.['metadata'] as Record<string, unknown>)['permissionId'], permission['permission_id']);
});

test('RPC permission request mode supports explicit deny', async () => {
  let confirmationHandler: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined;
  const { host } = createHost({
    async run() {
      assert.ok(confirmationHandler);
      const decision = await confirmationHandler({
        toolCall: {
          id: 'call-deny',
          type: 'function',
          function: {
            name: 'bash',
            arguments: { command: 'rm -rf tmp' },
          },
        },
        tool: {
          name: 'bash',
          description: 'Run shell command',
          parameters: {},
          metadata: {
            category: 'bash',
            riskLevel: 'high',
            source: 'builtin',
            isReadOnly: false,
            isConcurrencySafe: false,
            requiresConfirmation: true,
          },
          async execute() {
            return { success: true, content: 'ok' };
          },
        },
        args: { command: 'rm -rf tmp' },
        metadata: {
          category: 'bash',
          riskLevel: 'high',
          source: 'builtin',
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresConfirmation: true,
        },
      });
      return `decision:${decision}`;
    },
  });
  const output = new JsonlOutput();
  const state = createState();

  const promptTask = handleRpcRequest({
    host,
    state,
    request: {
      id: 'prompt-deny',
      method: 'prompt',
      params: {
        prompt: 'please run bash',
        permission_mode: 'request',
        permission_timeout_ms: 10000,
      },
    },
    output: output as unknown as NodeJS.WritableStream,
    setToolConfirmationHandler(handler) {
      confirmationHandler = handler;
    },
  });

  await waitFor(() => output.envelopes().some((envelope) => {
    const event = envelope['event'] as Record<string, unknown> | undefined;
    return event?.['type'] === 'permission_pending';
  }));

  const permissionEnvelope = output.envelopes().find((envelope) => {
    const event = envelope['event'] as Record<string, unknown> | undefined;
    return event?.['type'] === 'permission_pending';
  })!;
  const permission = (permissionEnvelope['event'] as Record<string, unknown>)['permission'] as Record<string, unknown>;

  await handleRpcRequest({
    host,
    state,
    request: {
      id: 'deny-1',
      method: 'deny_permission',
      params: { permission_id: permission['permission_id'], reason: 'not allowed' },
    },
    output: output as unknown as NodeJS.WritableStream,
  });
  await promptTask;

  const envelopes = output.envelopes();
  const denyResponse = envelopes.find((envelope) => envelope['id'] === 'deny-1')!;
  const finalResponse = envelopes.find((envelope) => envelope['id'] === 'prompt-deny' && envelope['type'] === 'response')!;
  assert.equal((denyResponse['result'] as Record<string, unknown>)['decision'], 'deny');
  assert.equal((finalResponse['result'] as Record<string, unknown>)['finalContent'], 'decision:deny');
  assert.equal(confirmationHandler, undefined);
});

test('RPC permission request mode denies pending permission on timeout', async () => {
  let confirmationHandler: ((request: ToolConfirmationRequest) => Promise<ToolPermissionDecision>) | undefined;
  const { host } = createHost({
    async run() {
      assert.ok(confirmationHandler);
      const decision = await confirmationHandler({
        toolCall: {
          id: 'call-timeout',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: { path: 'late.txt' },
          },
        },
        tool: {
          name: 'write_file',
          description: 'Write file',
          parameters: {},
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
        },
        args: { path: 'late.txt' },
        metadata: {
          category: 'write',
          riskLevel: 'high',
          source: 'builtin',
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresConfirmation: true,
        },
      });
      return `decision:${decision}`;
    },
  });
  const output = new JsonlOutput();
  const state = createState();

  await handleRpcRequest({
    host,
    state,
    request: {
      id: 'prompt-timeout',
      method: 'prompt',
      params: {
        prompt: 'please write later',
        permission_mode: 'request',
        permission_timeout_ms: 1,
      },
    },
    output: output as unknown as NodeJS.WritableStream,
    setToolConfirmationHandler(handler) {
      confirmationHandler = handler;
    },
  });

  const finalResponse = output.envelopes().find((envelope) => (
    envelope['id'] === 'prompt-timeout' && envelope['type'] === 'response'
  ))!;
  assert.equal((finalResponse['result'] as Record<string, unknown>)['finalContent'], 'decision:deny');
  assert.equal(confirmationHandler, undefined);
});
