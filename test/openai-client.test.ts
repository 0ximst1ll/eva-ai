import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIClient } from '../src/llm/openai-client.js';

test('OpenAIClient applies provider request options to chat completion params', async () => {
  const client = new OpenAIClient(
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
