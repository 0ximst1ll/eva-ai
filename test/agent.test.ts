import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/core/agent.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

function createToolCall(id: string, name: string) {
  return {
    id,
    type: 'function',
    function: { name, arguments: {} },
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

test('Agent drains steering before a run and follow-up after a turn', async () => {
  const llm = new ScriptedLLM([
    { content: 'first', finish_reason: 'stop' },
    { content: 'second', finish_reason: 'stop' },
  ]);
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
  });

  agent.steer({ role: 'user', content: 'steered' });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'assistant_message' && event.message.content === 'first') {
      agent.followUp({ role: 'user', content: 'follow-up' });
    }
  });

  try {
    assert.equal(await agent.continue(), 'second');
  } finally {
    unsubscribe();
  }

  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[0].map((message) => message.content), ['system', 'steered']);
  assert.deepEqual(llm.calls[1].at(-1), { role: 'user', content: 'follow-up' });
});

test('Agent aborts an active run through the loop signal', async () => {
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [createToolCall('call-1', 'wait_for_abort')],
    },
  ]);
  const tool: Tool = {
    name: 'wait_for_abort',
    description: 'Wait until aborted',
    parameters: { type: 'object' },
    metadata: {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute(_args, context) {
      return new Promise((resolve) => {
        if (context?.signal?.aborted) {
          resolve({ success: false, content: '', error: 'aborted' });
          return;
        }
        context?.signal?.addEventListener(
          'abort',
          () => resolve({ success: false, content: '', error: 'aborted' }),
          { once: true },
        );
      });
    },
  };
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [tool],
    maxSteps: 3,
  });

  const finalContent = new Promise<string>((resolve, reject) => {
    agent.continue().then(resolve, reject);
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'tool_execution_start') agent.abort();
  });

  try {
    assert.equal(await finalContent, 'Task cancelled by user.');
    assert.equal(agent.state.errorMessage, 'Task cancelled by user.');
  } finally {
    unsubscribe();
  }
});

