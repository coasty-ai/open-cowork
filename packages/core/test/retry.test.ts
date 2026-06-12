import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/retry';
import { CoastyApiError, CoastyNetworkError, isRetryableError } from '../src/errors';

const instantSleep = vi.fn(async (_ms: number) => {});

function retryable(msg = 'transient'): CoastyNetworkError {
  return new CoastyNetworkError(msg);
}

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => 42, { sleep });
    expect(result).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries retryable errors then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw retryable();
        return 'ok';
      },
      { maxAttempts: 3, sleep: instantSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws immediately on non-retryable errors', async () => {
    const err = new CoastyApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'bad field' });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw err;
        },
        { sleep: instantSleep },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it('rethrows the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw retryable(`attempt-${calls}`);
        },
        { maxAttempts: 4, sleep: instantSleep },
      ),
    ).rejects.toThrow('attempt-4');
    expect(calls).toBe(4);
  });

  it('uses exponential backoff with full jitter: delay = random * min(maxMs, base * 2^n)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw retryable();
        return 1;
      },
      { maxAttempts: 4, baseMs: 100, maxMs: 10_000, sleep, random: () => 0.5 },
    );
    // attempts 0,1,2 failed → delays 0.5*100, 0.5*200, 0.5*400
    expect(delays).toEqual([50, 100, 200]);
  });

  it('caps the backoff at maxMs', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw retryable();
        return 1;
      },
      {
        maxAttempts: 3,
        baseMs: 10_000,
        maxMs: 1_000,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 1,
      },
    );
    expect(delays.every((d) => d <= 1_000)).toBe(true);
  });

  it('honors an explicit retryAfterMs from the error over computed backoff', async () => {
    const delays: number[] = [];
    const err = new CoastyApiError({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'busy',
      retryAfterMs: 1234,
    });
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw err;
        return 'done';
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0.99,
      },
    );
    expect(delays).toEqual([1234]);
  });

  it('invokes onRetry with attempt number and delay', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw retryable();
        return 1;
      },
      { sleep: instantSleep, onRetry, random: () => 0.5 },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1);
  });

  it('aborts before an attempt when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      withRetry(async () => 1, { signal: controller.signal, sleep: instantSleep }),
    ).rejects.toThrow('stop');
  });

  it('abort during the sleep rejects', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw retryable();
      },
      {
        signal: controller.signal,
        // real abortable sleep semantics: reject on abort (also when already aborted,
        // since the abort may land before the sleep is entered)
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('aborted-during-sleep'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new Error('aborted-during-sleep')), {
              once: true,
            });
          }),
      },
    );
    controller.abort();
    await expect(promise).rejects.toThrow('aborted-during-sleep');
    expect(calls).toBe(1);
  });
});

describe('isRetryableError', () => {
  it('classifies per the documented catalog', () => {
    expect(isRetryableError(new CoastyNetworkError('x'))).toBe(true);
    expect(
      isRetryableError(new CoastyApiError({ status: 429, code: 'RATE_LIMITED', message: '' })),
    ).toBe(true);
    expect(
      isRetryableError(
        new CoastyApiError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', message: '' }),
      ),
    ).toBe(true);
    expect(
      isRetryableError(new CoastyApiError({ status: 504, code: 'UPSTREAM_TIMEOUT', message: '' })),
    ).toBe(true);
    expect(
      isRetryableError(new CoastyApiError({ status: 500, code: 'INTERNAL_ERROR', message: '' })),
    ).toBe(true);
    expect(
      isRetryableError(
        new CoastyApiError({ status: 402, code: 'INSUFFICIENT_CREDITS', message: '' }),
      ),
    ).toBe(false);
    expect(
      isRetryableError(new CoastyApiError({ status: 401, code: 'INVALID_API_KEY', message: '' })),
    ).toBe(false);
    expect(
      isRetryableError(new CoastyApiError({ status: 409, code: 'INVALID_STATE', message: '' })),
    ).toBe(false);
    expect(isRetryableError(new Error('random'))).toBe(false);
  });
});
