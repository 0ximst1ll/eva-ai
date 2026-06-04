import assert from 'node:assert/strict';
import test from 'node:test';
import { isInternalAgentMessage } from '../src/core/agent-messages.js';
import { AgentSession } from '../src/core/agent-session.js';
import {
  DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS,
  createContextBuilder,
} from '../src/core/context-builder.js';
import { createContextManager } from '../src/core/context-manager.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type {
  AgentMessage,
  AgentSessionEvent,
  InternalAgentMessage,
  LLMResponse,
  LLMStreamEvent,
  Message,
} from '../src/schema.js';
import type { Tool } from '../src/tools/base.js';

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

class MidStreamThenSuccessLLM {
  calls: Message[][] = [];

  constructor(
    private readonly error: Error,
    private readonly success: LLMResponse,
  ) {}

  async generate(): Promise<LLMResponse> {
    throw new Error('generate not implemented');
  }

  async *generateStream(messages: Message[]): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
    this.calls.push(messages.map((message) => ({ ...message })) as Message[]);
    if (this.calls.length === 1) {
      yield { type: 'content_delta', text: 'partial failed output' };
      throw this.error;
    }
    yield { type: 'done', response: this.success };
    return this.success;
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
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
  const events = [] as string[];

  await session.addUserMessage('run');
  assert.equal(await session.run({
    onEvent(event) {
      if (event.type === 'agent_end') {
        events.push(...event.messages.map((message) => message.role));
      }
    },
  }), 'done');

  assert.match(llm.calls[0]?.[1]?.content ?? '', /Contents of AGENTS\.md:/);
  assert.deepEqual(events, ['system', 'user', 'internal', 'assistant']);
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

test('AgentSession persists tool result details in session history', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'tool-details-session');
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-1', 'inspect', { path: 'README.md' })],
    },
    {
      content: 'done',
      finish_reason: 'stop',
    },
  ]);
  const tool: Tool = {
    name: 'inspect',
    description: 'Inspect a file',
    parameters: { type: 'object' },
    async execute() {
      return {
        success: true,
        content: '1|hello',
        details: {
          totalLines: 12,
          shownLines: 1,
        },
      };
    },
  };
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [tool],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('inspect README');
  assert.equal(await session.run(), 'done');

  const toolMessage = sessionManager.getMessages(sessionId).find((message) => message.role === 'tool');
  assert.deepEqual(toolMessage, {
    role: 'tool',
    content: '1|hello',
    tool_call_id: 'call-1',
    name: 'inspect',
    details: {
      totalLines: 12,
      shownLines: 1,
    },
  });
});

test('AgentSession persists tool result content blocks in session history', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'tool-blocks-session');
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-1', 'blocks')],
    },
    {
      content: 'done',
      finish_reason: 'stop',
    },
  ]);
  const tool: Tool = {
    name: 'blocks',
    description: 'Return block content',
    parameters: { type: 'object' },
    async execute() {
      return {
        success: true,
        content: 'fallback text',
        contentBlocks: [
          { type: 'text', text: 'first block' },
          { type: 'text', text: 'second block' },
        ],
      };
    },
  };
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [tool],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('run blocks');
  assert.equal(await session.run(), 'done');

  const toolMessage = sessionManager.getMessages(sessionId).find((message) => message.role === 'tool');
  assert.deepEqual(toolMessage, {
    role: 'tool',
    content: 'first block\nsecond block',
    tool_call_id: 'call-1',
    name: 'blocks',
    contentBlocks: [
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second block' },
    ],
  });
});

test('AgentSession forwards agent lifecycle events to the UI boundary', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const llm = new ScriptedLLM([{ content: 'done', finish_reason: 'stop' }]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });
  const events: string[] = [];

  await session.addUserMessage('run');
  assert.equal(await session.run({ onEvent: (event) => events.push(event.type) }), 'done');

  assert.equal(events[0], 'agent_start');
  assert.equal(events.at(-1), 'agent_end');
});

test('AgentSession auto-retries transient provider errors without ending the task', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const providerError = new Error(
    'ApiError: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand. Please try again later.\\",\\n    \\"status\\": \\"UNAVAILABLE\\"\\n  }\\n}\\n","code":503,"status":"Service Unavailable"}}',
  );
  const llm = new ScriptedLLM([
    providerError,
    { content: 'done after retry', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    autoRetry: { maxRetries: 2, initialDelayMs: 0 },
    sessionManager,
    sessionId,
  });
  const events: AgentSessionEvent[] = [];

  await session.addUserMessage('run');
  assert.equal(await session.run({ onEvent: (event) => events.push(event) }), 'done after retry');

  assert.equal(llm.calls.length, 2);
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type === 'error'),
    [],
  );
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type === 'agent_end'),
    ['agent_end'],
  );
  const retryStart = events.find((event) => event.type === 'auto_retry_start');
  assert.equal(retryStart?.type, 'auto_retry_start');
  assert.equal(retryStart.attempt, 1);
  assert.match(retryStart.errorMessage, /Provider unavailable|high demand/);
  const retryEnd = events.find((event) => event.type === 'auto_retry_end');
  assert.deepEqual(retryEnd, { type: 'auto_retry_end', success: true, attempt: 1 });
  assert.deepEqual(
    session.messages.map((message) => message.content),
    ['system', 'run', 'done after retry'],
  );
});

test('AgentSession retries mid-stream provider failures from durable message boundary', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const providerError = new Error(
    'ApiError: {"error":{"code":503,"message":"This model is currently experiencing high demand","status":"UNAVAILABLE"}}',
  );
  const llm = new MidStreamThenSuccessLLM(
    providerError,
    { content: 'done after stream retry', finish_reason: 'stop' },
  );
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
    autoRetry: { maxRetries: 1, initialDelayMs: 0 },
    sessionManager,
    sessionId,
  });
  const events: AgentSessionEvent[] = [];
  const finalAgentEndMessages: AgentMessage[] = [];

  await session.addUserMessage('run');
  assert.equal(await session.run({
    onEvent(event) {
      events.push(event);
      if (event.type === 'agent_end') {
        finalAgentEndMessages.splice(0, finalAgentEndMessages.length, ...event.messages);
      }
    },
  }), 'done after stream retry');

  assert.equal(llm.calls.length, 2);
  assert.deepEqual(
    sessionManager.getMessages(sessionId).map((message) => message.content),
    ['system', 'run', 'done after stream retry'],
  );
  assert.deepEqual(
    finalAgentEndMessages.map((message) => message.role),
    ['system', 'user', 'internal', 'assistant'],
  );
  assert.equal(
    finalAgentEndMessages.filter((message) => isInternalAgentMessage(message) && message.kind === 'resource_context').length,
    1,
  );
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type === 'error'),
    [],
  );
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type === 'auto_retry_start'),
    ['auto_retry_start'],
  );
});

test('AgentSession uses provider Retry-After for auto-retry delay', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const providerError = new Error(
    'ApiError: {"status":429,"headers":{"retry-after":"0.001"},"error":{"message":"rate limit exceeded"}}',
  );
  const llm = new ScriptedLLM([
    providerError,
    { content: 'done after retry-after', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    autoRetry: { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 5000 },
    sessionManager,
    sessionId,
  });
  const events: AgentSessionEvent[] = [];

  await session.addUserMessage('run');
  assert.equal(await session.run({ onEvent: (event) => events.push(event) }), 'done after retry-after');

  const retryStart = events.find((event) => event.type === 'auto_retry_start');
  assert.equal(retryStart?.type, 'auto_retry_start');
  assert.equal(retryStart.delayMs, 1);
  assert.match(retryStart.errorMessage, /rate limited|rate limit/i);
});

test('AgentSession stops provider auto-retry at the configured retry cap', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const providerError = new Error(
    'ApiError: {"error":{"code":503,"message":"This model is currently experiencing high demand","status":"UNAVAILABLE"}}',
  );
  const llm = new ScriptedLLM([providerError, providerError]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    autoRetry: { maxRetries: 1, initialDelayMs: 0 },
    sessionManager,
    sessionId,
  });
  const events: AgentSessionEvent[] = [];

  await session.addUserMessage('run');
  const result = await session.run({ onEvent: (event) => events.push(event) });

  assert.equal(llm.calls.length, 2);
  assert.match(result, /LLM call failed/);
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type === 'auto_retry_start'),
    ['auto_retry_start'],
  );
  const retryEnd = events.find((event) => event.type === 'auto_retry_end');
  assert.equal(retryEnd?.type, 'auto_retry_end');
  assert.equal(retryEnd.success, false);
  assert.equal(retryEnd.attempt, 1);
  assert.match(retryEnd.finalError ?? '', /LLM call failed/);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.deepEqual(
    session.messages.map((message) => message.content),
    ['system', 'run'],
  );
});

test('AgentSession keeps large tool results as truncated preview without artifacts', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  const largeOutput = 'x'.repeat(300);
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
  const events: AgentSessionEvent[] = [];
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [tool],
    maxSteps: 3,
    toolResultBudget: { maxChars: 120 },
    sessionManager,
    sessionId,
  });

  await session.addUserMessage('run');
  assert.equal(await session.run({ onEvent: (event) => events.push(event) }), 'done');

  const toolEvent = events.find((event) => event.type === 'tool_result');
  assert.equal(toolEvent?.type, 'tool_result');
  assert.equal(toolEvent.result.contentTruncated, true);
  assert.equal(toolEvent.result.originalContentLength, largeOutput.length);
  assert.equal(toolEvent.result.maxContentLength, 120);

  const providerToolMessage = llm.calls[1]?.at(-1);
  assert.equal(providerToolMessage?.role, 'tool');
  assert.ok((providerToolMessage?.content ?? '').length <= 120);
  assert.match(providerToolMessage?.content ?? '', /Tool result truncated/);
  assert.doesNotMatch(providerToolMessage?.content ?? '', /artifact=/);
  assert.notEqual(providerToolMessage?.content, largeOutput);

  const internalEntries = sessionManager.getInternalEntries(sessionId, 'tool_result_artifact');
  assert.equal(internalEntries.length, 0);
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

test('AgentSession keeps compaction summary marker internal and out of persisted session history', async () => {
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
    { content: 'Compacted work summary.', finish_reason: 'stop' },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const session = new AgentSession({
    llmClient: llm as unknown as LLMClient,
    systemPrompt: 'system',
    tools: [],
    maxSteps: 3,
    sessionManager,
    sessionId,
  });
  const agentEndMessages: AgentMessage[] = [];

  await session.compact('keep current task');
  await session.addUserMessage('continue');
  assert.equal(await session.run({
    onEvent(event) {
      if (event.type === 'agent_end') {
        agentEndMessages.push(...event.messages);
      }
    },
  }), 'done');

  const marker = agentEndMessages.find((message): message is InternalAgentMessage => (
    isInternalAgentMessage(message) && message.kind === 'compaction_summary'
  ));
  assert.equal(marker?.content, 'Compacted work summary.');
  assert.equal(marker?.metadata?.['summaryLength'], 'Compacted work summary.'.length);
  assert.equal(marker?.metadata?.['customInstructions'], true);
  assert.equal(llm.calls[0]?.map((message) => message.role as string).includes('internal'), false);
  assert.equal(sessionManager.getMessages(sessionId).map((message) => message.role as string).includes('internal'), false);
});

test('AgentSession uses the post-compact project context budget on the next run', async () => {
  const sessionManager = new SessionManager({
    workspaceDir: '/workspace',
    mode: 'memory',
  });
  const sessionId = await sessionManager.createSession('system', 'session-1');
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'first task' });
  await sessionManager.appendMessage(sessionId, { role: 'assistant', content: 'first answer' });
  await sessionManager.appendMessage(sessionId, { role: 'user', content: 'second task' });
  const llm = new ScriptedLLM([
    { content: 'Previous work summary.', finish_reason: 'stop' },
    { content: 'done', finish_reason: 'stop' },
  ]);
  const contextBuilder = createContextBuilder({
    projectContext: [{
      type: 'project_context',
      name: 'AGENTS.md',
      path: '/workspace/AGENTS.md',
      content: 'A'.repeat(8000),
    }],
    projectContextMaxChars: 20000,
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

  await session.compact();
  await session.addUserMessage('continue');
  assert.equal(await session.run(), 'done');

  assert.equal(llm.generateCalls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(contextBuilder.latestBuild?.projectContextBudgetMode, 'post_compact');
  assert.equal(contextBuilder.latestBuild?.projectContextMaxChars, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS);
  assert.equal(llm.calls[0]?.[1]?.content.length, DEFAULT_POST_COMPACT_PROJECT_CONTEXT_MAX_CHARS);
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
  assert.deepEqual(events.filter((event) => event === 'agent_start'), ['agent_start']);
  assert.deepEqual(events.filter((event) => event === 'agent_end'), ['agent_end']);
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
