import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateContentResponse } from '@google/genai';
import { GoogleClient } from '../src/llm/google-client.js';
import type { Message } from '../src/schema.js';

class InspectableGoogleClient extends GoogleClient {
  convert(messages: Message[]) {
    return this._convertMessages(messages);
  }

  parse(response: GenerateContentResponse) {
    return this._parseResponse(response);
  }
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
