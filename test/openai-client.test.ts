import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIClient } from '../src/llm/openai-client.js';

class InspectableOpenAIClient extends OpenAIClient {
  clientOptions() {
    return this._buildClientOptions();
  }
}

test('OpenAIClient applies provider request options to chat completion params', async () => {
  const client = new InspectableOpenAIClient(
    'test-key',
    'https://example.test',
    'openai-test',
    undefined,
    {
      temperature: 0.4,
      maxTokens: 1024,
    },
  );
  let requestBody: Record<string, unknown> | undefined;
  const inspectable = client as unknown as {
    client: {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => Promise<unknown>;
        };
      };
    };
  };
  inspectable.client.chat.completions.create = async (body) => {
    requestBody = body;
    return {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
  };

  const response = await client.generate([{ role: 'user', content: 'hello' }]);

  assert.equal(response.content, 'ok');
  assert.equal(requestBody?.['model'], 'openai-test');
  assert.equal(requestBody?.['temperature'], 0.4);
  assert.equal(requestBody?.['max_tokens'], 1024);
});

test('OpenAIClient forwards abort signal to SDK request options', async () => {
  const client = new InspectableOpenAIClient('test-key', 'https://example.test', 'openai-test');
  const controller = new AbortController();
  let requestOptions: Record<string, unknown> | undefined;
  const inspectable = client as unknown as {
    client: {
      chat: {
        completions: {
          create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
        };
      };
    };
  };
  inspectable.client.chat.completions.create = async (_body, options) => {
    requestOptions = options;
    return {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
  };

  await client.generate([{ role: 'user', content: 'hello' }], null, { signal: controller.signal });

  assert.equal(requestOptions?.['signal'], controller.signal);
});

test('OpenAIClient applies provider transport options to SDK client options', () => {
  const client = new InspectableOpenAIClient(
    'test-key',
    'https://example.test',
    'openai-test',
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
    defaultHeaders: { 'x-eva-session': 'session-1' },
    timeout: 30000,
    maxRetries: 2,
  });
});
