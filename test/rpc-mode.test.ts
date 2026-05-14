import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRpcLine, handleRpcRequest } from '../src/modes/rpc-mode.js';
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

function createHost() {
  let sessionId = 'session-1';
  const messages: Message[] = [{ role: 'system', content: 'system' }];
  let runCalls = 0;
  let addUserMessageCalls = 0;
  let newSessionCalls = 0;
  let resumeLatestSessionCalls = 0;
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
  } as unknown as RuntimeHost;

  return {
    host,
    stats: {
      get runCalls() { return runCalls; },
      get addUserMessageCalls() { return addUserMessageCalls; },
      get newSessionCalls() { return newSessionCalls; },
      get resumeLatestSessionCalls() { return resumeLatestSessionCalls; },
      switchedSessions,
    },
  };
}

function createState() {
  return { activeAbortController: null };
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

  assert.equal(stats.newSessionCalls, 1);
  assert.equal(stats.resumeLatestSessionCalls, 1);
  assert.deepEqual(stats.switchedSessions, ['session-target']);
  assert.deepEqual(
    output.envelopes().map((envelope) => envelope['type']),
    ['response', 'response', 'response'],
  );
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
