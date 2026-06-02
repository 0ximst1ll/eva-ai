import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicClient } from '../src/llm/anthropic-client.js';

class InspectableAnthropicClient extends AnthropicClient {
  clientOptions() {
    return this._buildClientOptions();
  }
}

test('AnthropicClient applies provider request options to message params', async () => {
  const client = new InspectableAnthropicClient(
    'test-key',
    'https://example.test',
    'claude-test',
    undefined,
    {
      temperature: 0.3,
      maxTokens: 2048,
    },
  );
  let requestBody: Record<string, unknown> | undefined;
  const inspectable = client as unknown as {
    client: {
      messages: {
        create: (body: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  inspectable.client.messages.create = async (body) => {
    requestBody = body;
    return {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    };
  };

  const response = await client.generate([{ role: 'user', content: 'hello' }]);

  assert.equal(response.content, 'ok');
  assert.equal(requestBody?.['model'], 'claude-test');
  assert.equal(requestBody?.['max_tokens'], 2048);
  assert.equal(requestBody?.['temperature'], 0.3);
});

test('AnthropicClient applies provider transport options to SDK client options', () => {
  const client = new InspectableAnthropicClient(
    'test-key',
    'https://example.test',
    'claude-test',
    undefined,
    {
      headers: { 'x-eva-session': 'session-1' },
      timeoutMs: 30000,
      maxRetries: 2,
    },
  );

  assert.deepEqual(client.clientOptions(), {
    apiKey: 'test-key',
    baseURL: 'https://example.test',
    defaultHeaders: {
      Authorization: 'Bearer test-key',
      'x-eva-session': 'session-1',
    },
    timeout: 30000,
    maxRetries: 2,
  });
});

test('AnthropicClient countTokens uses Anthropic countTokens API shape', async () => {
  const client = new AnthropicClient('test-key', 'https://example.test', 'claude-test');
  let requestBody: Record<string, unknown> | undefined;
  const inspectable = client as unknown as {
    client: {
      messages: {
        countTokens: (body: Record<string, unknown>) => Promise<{ input_tokens: number }>;
      };
    };
  };
  inspectable.client.messages.countTokens = async (body) => {
    requestBody = body;
    return { input_tokens: 123 };
  };

  const tokens = await client.countTokens([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
  ]);

  assert.equal(tokens, 123);
  assert.equal(requestBody?.['model'], 'claude-test');
  assert.equal(requestBody?.['system'], 'system prompt');
  assert.deepEqual(requestBody?.['messages'], [{ role: 'user', content: 'hello' }]);
});
