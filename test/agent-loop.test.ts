import assert from 'node:assert/strict';
import test from 'node:test';
import { createInternalAgentMessage, defaultConvertToLlm } from '../src/core/agent-messages.js';
import { createContextBuilder } from '../src/core/context-builder.js';
import { runAgentLoop, type AgentLoopEvent } from '../src/core/agent-loop.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { AgentMessage, LLMResponse, LLMStreamEvent, LlmMessage } from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

type ScriptedLLMStep = LLMResponse | Error;

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

class ScriptedLLM {
  calls: LlmMessage[][] = [];

  constructor(private readonly responses: ScriptedLLMStep[]) {}

  async *generateStream(messages: LlmMessage[]): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    this.calls.push(messages.map((message) => ({ ...message })) as LlmMessage[]);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response');
    if (response instanceof Error) throw response;
    yield { type: 'done', response };
    return response;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('runAgentLoop continues after tool calls and preserves tool result order', async () => {
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-1', 'echo', { text: 'hello' })],
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const tool: Tool = {
    name: 'echo',
    description: 'Echo text',
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute(args) {
      return { success: true, content: String(args['text']) };
    },
  };
  const events: AgentLoopEvent[] = [];

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [tool],
    maxSteps: 3,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.finalContent, 'done');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[1].at(-1), {
    role: 'tool',
    content: 'hello',
    tool_call_id: 'call-1',
    name: 'echo',
  });
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_result').map((event) => event.result.toolCallId),
    ['call-1'],
  );
});

test('runAgentLoop applies tool result budget before the next provider request', async () => {
  const largeOutput = 'x'.repeat(500);
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-large', 'large_output')],
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const tool: Tool = {
    name: 'large_output',
    description: 'Return large output',
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute() {
      return { success: true, content: largeOutput };
    },
  };
  const events: AgentLoopEvent[] = [];

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [tool],
    maxSteps: 3,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    toolResultBudget: { maxChars: 120 },
    emit: (event) => {
      events.push(event);
    },
  });

  const toolMessage = llm.calls[1].at(-1);
  const toolResultEvent = events.find((event) => event.type === 'tool_result');
  assert.equal(result.finalContent, 'done');
  assert.equal(toolMessage?.role, 'tool');
  assert.ok((toolMessage?.content ?? '').length <= 120);
  assert.match(toolMessage?.content ?? '', /Tool result truncated/);
  assert.equal(toolResultEvent?.type, 'tool_result');
  assert.equal(toolResultEvent?.result.contentTruncated, true);
  assert.equal(toolResultEvent?.result.originalContentLength, largeOutput.length);
  assert.equal(
    result.messages.find((message) => message.role === 'tool')?.content,
    toolMessage?.content,
  );
});

test('runAgentLoop runs safe read-only tool calls in parallel and preserves result order', async () => {
  const first = createDeferred<string>();
  const second = createDeferred<string>();
  const starts: string[] = [];
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-first', 'read_first'), toolCall('call-second', 'read_second')],
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const createReadTool = (name: string, deferred: ReturnType<typeof createDeferred<string>>): Tool => ({
    name,
    description: `Read ${name}`,
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute() {
      starts.push(name);
      return { success: true, content: await deferred.promise };
    },
  });
  const events: AgentLoopEvent[] = [];

  const run = runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [createReadTool('read_first', first), createReadTool('read_second', second)],
    maxSteps: 3,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    emit: (event) => {
      events.push(event);
    },
  });

  await waitForCondition(() => starts.length === 2);
  second.resolve('second-result');
  first.resolve('first-result');
  const result = await run;

  assert.equal(result.finalContent, 'done');
  assert.deepEqual(starts, ['read_first', 'read_second']);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_result').map((event) => event.result.toolCallId),
    ['call-first', 'call-second'],
  );
  assert.deepEqual(
    llm.calls[1]?.slice(-2).map((message) => message.content),
    ['first-result', 'second-result'],
  );
});

test('runAgentLoop keeps unsafe tool calls serial even when parallel mode is enabled', async () => {
  const write = createDeferred<string>();
  const read = createDeferred<string>();
  const starts: string[] = [];
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-write', 'write_file'), toolCall('call-read', 'read_file')],
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const writeTool: Tool = {
    name: 'write_file',
    description: 'Write file',
    parameters: { type: 'object' },
    metadata: {
      category: 'write',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    async execute() {
      starts.push('write_file');
      return { success: true, content: await write.promise };
    },
  };
  const readTool: Tool = {
    name: 'read_file',
    description: 'Read file',
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute() {
      starts.push('read_file');
      return { success: true, content: await read.promise };
    },
  };

  const run = runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [writeTool, readTool],
    maxSteps: 3,
    toolExecution: 'parallel',
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
  });

  await waitForCondition(() => starts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(starts, ['write_file']);

  write.resolve('write-result');
  await waitForCondition(() => starts.length === 2);
  read.resolve('read-result');
  const result = await run;

  assert.equal(result.finalContent, 'done');
  assert.deepEqual(starts, ['write_file', 'read_file']);
  assert.deepEqual(
    llm.calls[1]?.slice(-2).map((message) => message.content),
    ['write-result', 'read-result'],
  );
});

test('runAgentLoop sends transient project context to the LLM without persisting it', async () => {
  const llm = new ScriptedLLM([
    { content: 'done', finish_reason: 'stop' },
  ]);
  const contextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: '# Project Instructions\nUse rg before grep.\n',
    }],
  });

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [],
    maxSteps: 3,
    systemPrompt: 'system',
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    contextBuilder,
  });

  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0]?.map((message) => message.role), ['system', 'user', 'user']);
  assert.match(llm.calls[0]?.[1]?.content ?? '', /Contents of AGENTS\.md:/);
  assert.deepEqual(result.messages.map((message) => message.role), ['system', 'user', 'internal', 'assistant']);
  const marker = result.messages.find((message) => message.role === 'internal');
  assert.equal(marker?.kind, 'resource_context');
  assert.deepEqual(marker?.metadata?.['resources'], ['AGENTS.md']);
  assert.equal(marker?.metadata?.['injected'], true);
});

test('runAgentLoop transforms agent messages before converting them to provider messages', async () => {
  const llm = new ScriptedLLM([{ content: 'done', finish_reason: 'stop' }]);
  const convertInputs: AgentMessage[][] = [];

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [],
    maxSteps: 3,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    transformContext(messages) {
      return [...messages, { role: 'user', content: 'transient request context' }];
    },
    convertToLlm(messages) {
      convertInputs.push(messages.map((message) => ({ ...message })) as AgentMessage[]);
      return messages.filter((message): message is LlmMessage => 'role' in message);
    },
  });

  assert.deepEqual(convertInputs[0]?.map((message) => 'role' in message ? message.content : ''), [
    'system',
    'run',
    'transient request context',
  ]);
  assert.deepEqual(llm.calls[0]?.map((message) => message.content), [
    'system',
    'run',
    'transient request context',
  ]);
  assert.deepEqual(
    result.messages.map((message) => 'role' in message ? message.content : ''),
    ['system', 'run', 'done'],
  );
});

test('runAgentLoop keeps internal agent messages out of provider requests', async () => {
  const llm = new ScriptedLLM([{ content: 'done', finish_reason: 'stop' }]);
  const internalMessage = createInternalAgentMessage({
    kind: 'context_marker',
    content: 'internal only',
    metadata: { source: 'test' },
  });
  const events: AgentLoopEvent[] = [];

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [],
    maxSteps: 3,
    messages: [
      { role: 'system', content: 'system' },
      internalMessage,
      { role: 'user', content: 'run' },
    ],
    emit: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(llm.calls[0]?.map((message) => message.content), ['system', 'run']);
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ['system', 'internal', 'user', 'assistant'],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'agent_end')
      .flatMap((event) => event.messages.map((message) => message.role)),
    ['system', 'internal', 'user', 'assistant'],
  );
});

test('defaultConvertToLlm filters internal agent messages', () => {
  const llmMessages = defaultConvertToLlm([
    { role: 'system', content: 'system' },
    createInternalAgentMessage({ kind: 'ui_state', content: 'do not send' }),
    { role: 'user', content: 'hello' },
  ]);

  assert.deepEqual(llmMessages.map((message) => message.content), ['system', 'hello']);
});

test('runAgentLoop can run without a max step guard', async () => {
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-1', 'echo')],
    },
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-2', 'echo')],
    },
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-3', 'echo')],
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const tool: Tool = {
    name: 'echo',
    description: 'Echo text',
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    async execute() {
      return { success: true, content: 'ok' };
    },
  };

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [tool],
    maxSteps: null,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
  });

  assert.equal(result.finalContent, 'done');
  assert.equal(llm.calls.length, 4);
});

test('runAgentLoop emits friendly provider error messages and preserves raw details', async () => {
  const providerError = new Error(
    'ApiError: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand. Please try again later.\\",\\n    \\"status\\": \\"UNAVAILABLE\\"\\n  }\\n}\\n","code":503,"status":"Service Unavailable"}}',
  );
  const llm = new ScriptedLLM([providerError]);
  const events: AgentLoopEvent[] = [];

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [],
    maxSteps: 3,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    emit: (event) => {
      events.push(event);
    },
  });

  const errorEvent = events.find((event) => event.type === 'error');
  assert.equal(errorEvent?.type, 'error');
  assert.match(result.finalContent, /Provider unavailable/);
  assert.match(errorEvent.message, /Provider unavailable/);
  assert.match(errorEvent.error ?? '', /high demand/);
});
