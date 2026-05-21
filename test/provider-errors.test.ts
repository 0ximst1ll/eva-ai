import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProviderError } from '../src/llm/provider-errors.js';

test('formatProviderError classifies nested Gemini 503 errors as unavailable', () => {
  const error = new Error(
    'ApiError: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\\",\\n    \\"status\\": \\"UNAVAILABLE\\"\\n  }\\n}\\n","code":503,"status":"Service Unavailable"}}',
  );

  const formatted = formatProviderError(error);

  assert.equal(formatted.category, 'unavailable');
  assert.equal(formatted.retryable, true);
  assert.equal(formatted.statusCode, 503);
  assert.match(formatted.message, /Provider unavailable/);
  assert.match(formatted.raw, /high demand/);
});
