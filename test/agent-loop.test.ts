import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder } from '../src/core/context-builder.js';
import { runAgentLoop, type AgentLoopEvent } from '../src/core/agent-loop.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

class ScriptedLLM {
  calls: Message[][] = [];

  constructor(private readonly responses: LLMResponse[]) {}

  async *generateStream(messages: Message[]): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    this.calls.push(messages.map((message) => ({ ...message })) as Message[]);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response');
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
