import assert from 'node:assert/strict';
import test from 'node:test';
import { countMessagesLocally, createTokenCounter } from '../src/core/token-counter.js';
import type { LLMClient } from '../src/llm/llm-client.js';
import { LLMProvider } from '../src/schema.js';
import type { Message } from '../src/schema.js';

const messages: Message[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'hello' },
];

test('TokenCounter uses provider count when available', async () => {
  const tokenCounter = createTokenCounter({
    llmClient: {
      provider: LLMProvider.ANTHROPIC,
      async countTokens(inputMessages: Message[]) {
        assert.deepEqual(inputMessages, messages);
        return 42;
      },
    } as unknown as LLMClient,
  });

  const result = await tokenCounter.countMessages({ messages });

  assert.deepEqual(result, {
    tokens: 42,
    source: 'provider',
    method: 'anthropic_count_tokens',
  });
});

test('TokenCounter reports Google provider count method', async () => {
  const tokenCounter = createTokenCounter({
    llmClient: {
      provider: LLMProvider.GOOGLE,
      async countTokens() {
        return 84;
      },
    } as unknown as LLMClient,
  });

  const result = await tokenCounter.countMessages({ messages });

  assert.deepEqual(result, {
    tokens: 84,
    source: 'provider',
    method: 'google_count_tokens',
  });
});

test('TokenCounter falls back to local count when provider count is unavailable', async () => {
  const tokenCounter = createTokenCounter({
    llmClient: {
      async countTokens() {
        return null;
      },
    } as unknown as LLMClient,
  });

  const result = await tokenCounter.countMessages({ messages });
  const local = countMessagesLocally(messages);

  assert.deepEqual(result, local);
  assert.equal(result.source, 'local');
  assert.equal(result.method, 'gpt-tokenizer');
});
