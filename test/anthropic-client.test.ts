import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicClient } from '../src/llm/anthropic-client.js';

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
