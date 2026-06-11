/**
 * Error classes for the Coasty client and the retry layer.
 * Branch on `code` (stable across API versions), never on `message`.
 */
import type { CoastyErrorBody, CoastyErrorCode, CoastyErrorType } from './types';

/** A non-2xx response from the Coasty API, parsed from the documented envelope. */
export class CoastyApiError extends Error {
  override readonly name = 'CoastyApiError';
  readonly status: number;
  readonly code: CoastyErrorCode;
  readonly errorType: CoastyErrorType;
  readonly requestId: string | undefined;
  readonly suggestion: string | undefined;
  /** Milliseconds to wait before retrying, from `Retry-After` / `retry_after`. */
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;
  /** The raw parsed error body, for code-specific extras (required/balance/...). */
  readonly raw: CoastyErrorBody['error'] | undefined;

  constructor(opts: {
    status: number;
    code: CoastyErrorCode;
    message: string;
    errorType?: CoastyErrorType;
    requestId?: string;
    suggestion?: string;
    retryAfterMs?: number;
    details?: unknown;
    raw?: CoastyErrorBody['error'];
  }) {
    super(opts.message);
    this.status = opts.status;
    this.code = opts.code;
    this.errorType = opts.errorType ?? 'server_error';
    this.requestId = opts.requestId;
    this.suggestion = opts.suggestion;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
    this.raw = opts.raw;
  }
}

/** The request never produced an HTTP response (DNS, connection reset, ...). */
export class CoastyNetworkError extends Error {
  override readonly name = 'CoastyNetworkError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** The request was aborted by the configured timeout. */
export class CoastyTimeoutError extends Error {
  override readonly name = 'CoastyTimeoutError';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Coasty request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** Error codes that are safe to retry per the docs' error catalog. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  'PREDICTION_FAILED',
  'GROUNDING_FAILED',
  'RATE_LIMITED',
]);

/**
 * True when retrying could plausibly succeed: network failures, timeouts,
 * HTTP 429/5xx, and the documented transient error codes. Validation, auth,
 * billing, state, and not-found errors are never retryable.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof CoastyNetworkError || err instanceof CoastyTimeoutError) return true;
  if (err instanceof CoastyApiError) {
    if (err.status === 429) return true;
    if (err.status >= 500) return true;
    return RETRYABLE_CODES.has(err.code);
  }
  return false;
}

/** Build a CoastyApiError from an HTTP status, parsed body, and Retry-After header. */
export function coastyErrorFromResponse(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): CoastyApiError {
  const envelope = (body ?? {}) as Partial<CoastyErrorBody>;
  const err = envelope.error;
  const headerMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
  const bodyMs = typeof err?.retry_after === 'number' ? err.retry_after * 1000 : undefined;
  return new CoastyApiError({
    status,
    code: err?.code ?? 'INTERNAL_ERROR',
    message: err?.message ?? `Coasty API error (HTTP ${status})`,
    errorType: err?.type,
    requestId: err?.request_id,
    suggestion: err?.suggestion,
    retryAfterMs: Number.isFinite(headerMs) ? headerMs : bodyMs,
    details: err?.details,
    raw: err,
  });
}
