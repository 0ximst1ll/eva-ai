import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateContentResponse } from '@google/genai';
import { GoogleClient } from '../src/llm/google-client.js';
import { createProviderModel, type ProviderRequestOptions } from '../src/llm/provider.js';
import type { Message } from '../src/schema.js';
import { LLMProvider } from '../src/schema.js';

class InspectableGoogleClient extends GoogleClient {
  convert(messages: Message[]) {
    return this._convertMessages(messages);
  }

  buildConfig(systemInstruction: string | null = null) {
    return this._buildConfig(systemInstruction);
  }

  parse(response: GenerateContentResponse) {
    return this._parseResponse(response);
  }
}

function createInspectableGoogleClient(model: string, requestOptions: ProviderRequestOptions = {}) {
  return new InspectableGoogleClient(
    'test-key',
    '',
    model,
    undefined,
    createProviderModel({
      provider: LLMProvider.GOOGLE,
      providerName: 'google',
      model,
      baseUrl: '',
    }),
    requestOptions,
  );
}

test('GoogleClient preserves thought signatures on function call history', () => {
  const client = new InspectableGoogleClient('test-key');
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: { path: 'README.md' } },
          providerMetadata: { google: { thoughtSignature: 'signature-a' } },
        },
      ],
    },
  ];

  const [, contents] = client.convert(messages);

  assert.deepEqual(contents[1], {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { path: 'README.md' },
        },
        thoughtSignature: 'signature-a',
      },
    ],
  });
});

test('GoogleClient stores thought signatures returned with function calls', () => {
  const client = new InspectableGoogleClient('test-key');

  const response = {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: 'README.md' },
              },
              thoughtSignature: 'signature-a',
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  } as unknown as GenerateContentResponse;

  const parsed = client.parse(response);

  assert.deepEqual(parsed.tool_calls?.[0], {
    id: 'call-1',
    type: 'function',
    function: { name: 'read_file', arguments: { path: 'README.md' } },
    providerMetadata: { google: { thoughtSignature: 'signature-a' } },
  });
});

test('GoogleClient maps Gemini 3 Flash reasoning to thinkingLevel', () => {
  const client = createInspectableGoogleClient('gemini-3.5-flash', { reasoning: 'high' });

  assert.deepEqual(client.buildConfig()['thinkingConfig'], {
    includeThoughts: true,
    thinkingLevel: 'HIGH',
  });
});

test('GoogleClient disables Gemini 3 Flash visible thoughts without includeThoughts', () => {
  const client = createInspectableGoogleClient('gemini-3.5-flash', { reasoning: 'off' });

  assert.deepEqual(client.buildConfig()['thinkingConfig'], {
    thinkingLevel: 'MINIMAL',
  });
});

test('GoogleClient maps Gemini 2.5 Flash reasoning to thinkingBudget', () => {
  const client = createInspectableGoogleClient('gemini-2.5-flash', { reasoning: 'high' });

  assert.deepEqual(client.buildConfig()['thinkingConfig'], {
    includeThoughts: true,
    thinkingBudget: 24576,
  });
});

test('GoogleClient omits thinkingConfig for non-reasoning Google models', () => {
  const client = createInspectableGoogleClient('gemini-2.0-flash', { reasoning: 'high' });

  assert.equal(client.buildConfig()['thinkingConfig'], undefined);
});

test('GoogleClient countTokens uses Google countTokens API shape', async () => {
  const client = new GoogleClient('test-key', '', 'gemini-test');
  let requestBody: Record<string, unknown> | undefined;
  const inspectable = client as unknown as {
    client: {
      models: {
        countTokens: (body: Record<string, unknown>) => Promise<{ totalTokens: number }>;
      };
    };
  };
  inspectable.client.models.countTokens = async (body) => {
    requestBody = body;
    return { totalTokens: 321 };
  };

  const tokens = await client.countTokens([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
  ]);

  assert.equal(tokens, 321);
  assert.equal(requestBody?.['model'], 'gemini-test');
  assert.deepEqual(requestBody?.['contents'], [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.deepEqual(requestBody?.['config'], { systemInstruction: 'system prompt' });
});
