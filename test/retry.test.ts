import assert from 'node:assert/strict';
import test from 'node:test';
import { RetryConfig, RetryExhaustedError, withRetry } from '../src/retry.js';

test('withRetry retries failures and returns the eventual result', async () => {
  const attempts: number[] = [];
  const retryEvents: Array<{ message: string; attempt: number }> = [];
  const wrapped = withRetry(
    async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) throw new Error(`failure ${attempts.length}`);
      return 'ok';
    },
    new RetryConfig({ maxRetries: 3, initialDelay: 0, maxDelay: 0 }),
    (error, attempt) => retryEvents.push({ message: error.message, attempt }),
  );

  await assert.doesNotReject(async () => {
    assert.equal(await wrapped(), 'ok');
  });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(retryEvents, [
    { message: 'failure 1', attempt: 1 },
    { message: 'failure 2', attempt: 2 },
  ]);
});

test('withRetry throws RetryExhaustedError after max retries are exhausted', async () => {
  const wrapped = withRetry(
    async () => {
      throw new Error('still failing');
    },
    new RetryConfig({ maxRetries: 2, initialDelay: 0, maxDelay: 0 }),
  );

  await assert.rejects(
    wrapped(),
    (error) => {
      assert.ok(error instanceof RetryExhaustedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.lastException.message, 'still failing');
      return true;
    },
  );
});

