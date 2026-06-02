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

test('formatProviderError classifies timeout errors as retryable', () => {
  const error = new Error('Request timed out after 30000ms');

  const formatted = formatProviderError(error);

  assert.equal(formatted.category, 'timeout');
  assert.equal(formatted.retryable, true);
  assert.equal(formatted.statusCode, undefined);
  assert.match(formatted.message, /timed out/);
});

test('formatProviderError extracts Retry-After from provider error metadata', () => {
  const error = new Error(
    'ApiError: {"status":429,"headers":{"retry-after":"2"},"error":{"message":"rate limit exceeded"}}',
  );

  const formatted = formatProviderError(error);

  assert.equal(formatted.category, 'rate_limited');
  assert.equal(formatted.retryable, true);
  assert.equal(formatted.statusCode, 429);
  assert.equal(formatted.retryAfterMs, 2000);
});

test('formatProviderError extracts Retry-After from header text', () => {
  const formatted = formatProviderError('HTTP 503 Service Unavailable\nretry-after: 3');

  assert.equal(formatted.category, 'unavailable');
  assert.equal(formatted.retryable, true);
  assert.equal(formatted.statusCode, 503);
  assert.equal(formatted.retryAfterMs, 3000);
});
