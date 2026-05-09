import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session.js';
import { createContextBuilder } from '../src/core/context-builder.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../src/schema.js';

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

test('AgentSession keeps transient project context out of session history', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
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
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    contextBuilder,
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('run');
  assert.equal(await session.run(), 'done');

  assert.match(llm.calls[0]?.[1]?.content ?? '', /Contents of AGENTS\.md:/);
  assert.deepEqual(
    sessionManager.getMessages(sessionId).map((message) => message.content),
    ['system', 'run', 'done'],
  );
});

test('AgentSession uses reloaded context resources on the next run', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system-old', 'session-1');
  const llm = new ScriptedLLM([
    { content: 'first', finish_reason: 'stop' },
    { content: 'second', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system-old',
    tools: [],
    maxSteps: 3,
    contextBuilder: createContextBuilder({
      projectContext: [{
        type: 'project_context',
        name: 'AGENTS.md',
        path: '/workspace/AGENTS.md',
        content: 'old instructions',
      }],
    }),
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('first run');
  assert.equal(await session.run(), 'first');

  session.updateRuntimeResources({
    systemPrompt: 'system-new',
    contextBuilder: createContextBuilder({
      projectContext: [{
        type: 'project_context',
        name: 'AGENTS.md',
        path: '/workspace/AGENTS.md',
        content: 'new instructions',
      }],
    }),
  });
  await session.addUserMessage('second run');
  assert.equal(await session.run(), 'second');

  assert.equal(llm.calls[1]?.[0]?.content, 'system-new');
  assert.match(llm.calls[1]?.[1]?.content ?? '', /new instructions/);
  assert.doesNotMatch(llm.calls[1]?.[1]?.content ?? '', /old instructions/);
  assert.deepEqual(
    sessionManager.getMessages(sessionId).map((message) => message.content),
    ['system-old', 'first run', 'first', 'second run', 'second'],
  );
});
