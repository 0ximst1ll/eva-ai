import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { runAgentLoop, type AgentLoopEvent } from '../src/core/agent-loop.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import type { LLMResponse, LLMStreamEvent, LlmMessage } from '../src/schema.js';
import { BashTool } from '../src/tools/bash.js';
import type { Tool } from '../src/tools/base.js';
import { ReadTool } from '../src/tools/read.js';
import { WriteTool } from '../src/tools/write.js';

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

test('agent-loop stops later serial tools after abort during tool execution', async () => {
  const controller = new AbortController();
  const starts: string[] = [];
  const events: AgentLoopEvent[] = [];
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [toolCall('call-first', 'first_write'), toolCall('call-second', 'second_write')],
    },
    { content: 'should-not-run', finish_reason: 'stop' },
  ]);

  const createWriteTool = (name: string, abort = false): Tool => ({
    name,
    description: name,
    parameters: { type: 'object' },
    metadata: {
      category: 'write',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    async execute() {
      starts.push(name);
      if (abort) controller.abort();
      return { success: !abort, content: abort ? '' : name, error: abort ? 'Operation aborted' : undefined };
    },
  });

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [createWriteTool('first_write', true), createWriteTool('second_write')],
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    signal: controller.signal,
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.finalContent, 'Task cancelled by user.');
  assert.deepEqual(starts, ['first_write']);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_execution_start').map((event) => event.toolName),
    ['first_write'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_result').map((event) => event.result.toolName),
    ['first_write'],
  );
});

test('agent-loop waits for an active parallel batch but skips later batches after abort', async () => {
  const controller = new AbortController();
  const starts: string[] = [];
  const llm = new ScriptedLLM([
    {
      content: '',
      finish_reason: 'tool_use',
      tool_calls: [
        toolCall('call-read-1', 'read_one'),
        toolCall('call-read-2', 'read_two'),
        toolCall('call-write', 'write_later'),
      ],
    },
  ]);

  const createReadTool = (name: string, abort = false): Tool => ({
    name,
    description: name,
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
      if (abort) {
        await Promise.resolve();
        controller.abort();
      }
      return { success: true, content: name };
    },
  });
  const writeTool: Tool = {
    name: 'write_later',
    description: 'write later',
    parameters: { type: 'object' },
    metadata: {
      category: 'write',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    async execute() {
      starts.push('write_later');
      return { success: true, content: 'write_later' };
    },
  };

  const result = await runAgentLoop({
    llmClient: llm as unknown as LLMClient,
    tools: [createReadTool('read_one', true), createReadTool('read_two'), writeTool],
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'run' }],
    signal: controller.signal,
  });

  assert.equal(result.finalContent, 'Task cancelled by user.');
  assert.deepEqual(starts.sort(), ['read_one', 'read_two']);
});

test('foreground bash abort terminates the command promptly', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-bash-abort-'));
  const controller = new AbortController();
  let fullOutputPath: string | undefined;
  try {
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await new BashTool(tempDir).execute(
      { command: 'sleep 5; echo done', timeout: 10 },
      { signal: controller.signal },
    );
    fullOutputPath = result.fullOutputPath;

    assert.equal(result.success, false);
    assert.equal(result.error, 'Command aborted');
    assert.doesNotMatch(result.stdout, /done/);
    assert.ok(Date.now() - startedAt < 3000);
  } finally {
    if (fullOutputPath) await fs.rm(fullOutputPath, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('synchronous file tools fail before mutation when already aborted', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-file-abort-'));
  const controller = new AbortController();
  controller.abort();
  try {
    await fs.writeFile(path.join(tempDir, 'readme.md'), 'hello', 'utf-8');

    const read = await new ReadTool(tempDir).execute({ path: 'readme.md' }, { signal: controller.signal });
    const write = await new WriteTool(tempDir).execute(
      { path: 'new.txt', content: 'should not exist' },
      { signal: controller.signal },
    );

    assert.equal(read.success, false);
    assert.equal(read.error, 'Operation aborted');
    assert.equal(write.success, false);
    assert.equal(write.error, 'Operation aborted');
    await assert.rejects(fs.readFile(path.join(tempDir, 'new.txt'), 'utf-8'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
