/**
 * Generic retry with exponential backoff and full jitter.
 * Deterministic in tests via injectable `sleep` and `random`.
 */
import { isRetryableError } from './errors';

export interface RetryOptions {
  /** Total attempts including the first one. Default 3. */
  maxAttempts?: number;
  /** Base delay for backoff. Default 250ms. */
  baseMs?: number;
  /** Upper bound for any single delay. Default 10_000ms. */
  maxMs?: number;
  /** Decides whether an error is retryable. Default {@link isRetryableError}. */
  retryOn?: (err: unknown) => boolean;
  /**
   * Extracts an explicit server-requested delay (e.g. Retry-After) from the error.
   * When it returns a number, it overrides the computed backoff for that attempt.
   * Default: reads `retryAfterMs` off the error if present.
   */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Called before each sleep with (attempt, delayMs, err). */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Abort waiting/retrying. Abort during a wait rejects with the signal reason. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. Returns [0, 1). */
  random?: () => number;
}

function defaultRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'retryAfterMs' in err) {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/** Default sleep that resolves early-rejects on abort. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying on retryable errors with exponential backoff + FULL jitter:
 * delay = random() * min(maxMs, baseMs * 2^attemptIndex), unless the error carries
 * an explicit retry-after, which is honored verbatim (capped at maxMs).
 * Rethrows the last error when attempts are exhausted or the error is not retryable.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseMs = 250,
    maxMs = 10_000,
    retryOn = isRetryableError,
    retryAfterMs = defaultRetryAfter,
    onRetry,
    signal,
    sleep = abortableSleep,
    random = Math.random,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !retryOn(err)) throw err;
      const explicit = retryAfterMs(err);
      const delay =
        explicit !== undefined
          ? Math.min(explicit, maxMs)
          : random() * Math.min(maxMs, baseMs * 2 ** attempt);
      onRetry?.(attempt + 1, delay, err);
      await sleep(delay, signal);
    }
  }
  // Unreachable: the loop either returned or threw. Satisfies the type checker.
  throw lastErr;
}
