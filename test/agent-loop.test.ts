import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { runAgentLoop, type AgentLoopEvent } from '../src/core/agent-loop.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../src/schema.js';
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
  calls: Message[][] = [];

  constructor(private readonly responses: ScriptedLLMStep[]) {}

  async *generateStream(messages: Message[]): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    this.calls.push(messages.map((message) => ({ ...message })) as Message[]);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response');
    if (response instanceof Error) throw response;
    yield { type: 'done', response };
    return response;
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
  assert.deepEqual(
    result.messages.map((message) => message.content),
    ['system', 'run', 'done'],
  );
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
