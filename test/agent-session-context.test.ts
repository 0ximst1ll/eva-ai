import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session.js';
import { createContextBuilder } from '../src/core/context-builder.js';
import { createContextManager } from '../src/core/context-manager.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../src/schema.js';

type ScriptedLLMStep = LLMResponse | Error;

class ScriptedLLM {
  calls: Message[][] = [];
  generateCalls: Message[][] = [];

  constructor(private readonly responses: ScriptedLLMStep[]) {}

  async generate(messages: Message[]): Promise<LLMResponse> {
    this.generateCalls.push(messages.map((message) => ({ ...message })) as Message[]);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response');
    if (response instanceof Error) throw response;
    return response;
  }

  async *generateStream(messages: Message[]): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    this.calls.push(messages.map((message) => ({ ...message })) as Message[]);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response');
    if (response instanceof Error) throw response;
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
    {
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    },
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
  assert.deepEqual(session.usage, {
    count: 1,
    total: {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    },
    latest: {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    },
    latestTimestamp: session.usage.latestTimestamp,
    latestSource: 'assistant',
  });
  assert.equal(session.apiTotalTokens, 9);
});

test('AgentSession compacts history into a summary message and keeps recent context', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'second task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'second answer' });
  const llm = new ScriptedLLM([
    {
      content: 'The user completed the first task and is now on the second task.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });

  const result = await session.compact('focus on remaining work');
  const messages = sessionManager.getMessages(sessionId);

  assert.equal(result.messagesBefore, 5);
  assert.equal(result.messagesAfter, messages.length);
  assert.equal(messages[0]?.content, 'system');
  assert.match(messages[1]?.content ?? '', /The user completed the first task/);
  assert.match(llm.generateCalls[0]?.[1]?.content ?? '', /focus on remaining work/);
  assert.equal(session.apiTotalTokens, 15);
  assert.equal(session.usage.count, 1);
  assert.equal(session.usage.latestSource, 'compaction');
});

test('AgentSession leaves session history unchanged when compaction fails', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'answer' });
  const before = sessionManager.getMessages(sessionId);
  const llm = new ScriptedLLM([{ content: '', finish_reason: 'stop' }]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });

  await assert.rejects(() => session.compact(), /summary is empty/);
  assert.deepEqual(sessionManager.getMessages(sessionId), before);
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

test('AgentSession automatically compacts before run when context reserve is reached', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'second task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'second answer' });
  const contextBuilder = createContextBuilder();
  const contextManager = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    compaction: { enabled: true, reserveTokens: 200 },
    tokenCounter: {
      async countMessages() {
        return { tokens: 850, source: 'provider', method: 'anthropic_count_tokens' };
      },
    },
  });
  const llm = new ScriptedLLM([
    {
      content: 'Earlier work was summarized.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    contextBuilder,
    contextManager,
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('current task');
  assert.equal(await session.run(), 'done');

  assert.equal(llm.generateCalls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.match(session.messages[1]?.content ?? '', /Earlier work was summarized/);
  assert.equal(session.compaction.compacted, true);
  assert.equal(session.usage.latestSource, 'compaction');
});

test('AgentSession continues the run when automatic compaction fails', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'answer' });
  const beforeRunMessages = sessionManager.getMessages(sessionId).map((message) => ({ ...message }));
  const contextBuilder = createContextBuilder();
  const contextManager = createContextManager({
    contextBuilder,
    sessionManager,
    contextWindowTokens: 1000,
    compaction: { enabled: true, reserveTokens: 200 },
    tokenCounter: {
      async countMessages() {
        return { tokens: 850, source: 'provider', method: 'anthropic_count_tokens' };
      },
    },
  });
  const llm = new ScriptedLLM([
    { content: '', finish_reason: 'stop' },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    contextBuilder,
    contextManager,
    sessionManager,
    sessionId,
  });

  assert.equal(await session.run(), 'done');

  assert.equal(llm.generateCalls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(session.compaction.compacted, false);
  assert.deepEqual(session.messages.slice(0, beforeRunMessages.length), beforeRunMessages);
  assert.equal(session.messages.at(-1)?.content, 'done');
});

test('AgentSession compacts and retries once after a context overflow error', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'current task' });
  const llm = new ScriptedLLM([
    new Error('context_length_exceeded: prompt is too long'),
    {
      content: 'Previous work was summarized.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
    { content: 'done after retry', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });
  const events = [] as string[];

  assert.equal(await session.run({ onEvent: (event) => events.push(event.type) }), 'done after retry');

  assert.equal(llm.calls.length, 2);
  assert.equal(llm.generateCalls.length, 1);
  assert.equal(session.compaction.compacted, true);
  assert.match(session.messages[1]?.content ?? '', /Previous work was summarized/);
  assert.equal(session.messages.at(-1)?.content, 'done after retry');
  assert.deepEqual(events.filter((event) => event === 'error'), []);
});

test('AgentSession returns the original context overflow error when recovery compaction fails', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'current task' });
  const beforeRunMessages = sessionManager.getMessages(sessionId).map((message) => ({ ...message }));
  const llm = new ScriptedLLM([
    new Error('input token count exceeds the model context window'),
    { content: '', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });
  const errors = [] as string[];

  const result = await session.run({
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event.message);
    },
  });

  assert.match(result, /LLM call failed/);
  assert.match(result, /context window/);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.generateCalls.length, 1);
  assert.equal(session.compaction.compacted, false);
  assert.deepEqual(session.messages, beforeRunMessages);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /context window/);
});
