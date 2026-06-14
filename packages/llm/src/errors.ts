/**
 * Uniform provider errors. Every provider (Coasty or BYO) funnels failures
 * through {@link mapProviderError} into a small, stable set of codes the UI
 * surfaces identically regardless of which LLM is behind the run.
 *
 * SECURITY: messages are curated; we never echo raw provider response bodies or
 * request headers (which can carry the API key). {@link redactKey} scrubs a
 * known key value from any string before it could be logged.
 */

export type ProviderErrorCode =
  | 'PROVIDER_AUTH' // 401/403, bad/expired/missing key
  | 'PROVIDER_UNREACHABLE' // DNS/connect/TLS failure (e.g. Ollama not running)
  | 'MODEL_NOT_FOUND' // 404 / unknown model
  | 'RATE_LIMITED' // 429
  | 'TIMEOUT' // abort / deadline
  | 'NO_VISION' // model can't see images but the run needs a screenshot
  | 'IMAGE_TOO_LARGE' // screenshot exceeds the provider payload cap
  | 'BAD_OUTPUT' // unparseable / non-standard model response
  | 'PROVIDER_ERROR'; // anything else

/** A normalized provider failure. `message` is safe to show the user. */
export class LlmProviderError extends Error {
  override readonly name = 'LlmProviderError';
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    /** For RATE_LIMITED: suggested wait before retry, if the provider gave one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Replace any occurrence of a secret value with `***` (defense-in-depth). */
export function redactKey(text: string, key?: string): string {
  if (!key || key.length < 6) return text;
  return text.split(key).join('***');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function statusOf(err: Record<string, unknown>): number | undefined {
  const s = err.statusCode ?? err.status ?? asRecord(err.response).status;
  return typeof s === 'number' ? s : undefined;
}

function codeStringOf(err: Record<string, unknown>): string {
  const parts = [err.code, err.errno, asRecord(err.cause).code, err.name, err.message];
  return parts
    .filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
    .map(String)
    .join(' ');
}

function retryAfterMsOf(err: Record<string, unknown>): number | undefined {
  const headers = asRecord(err.responseHeaders);
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? asRecord(err.data)['retry_after'];
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : undefined;
}

const UNREACHABLE_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|certificate|self.signed|unable to (?:get|verify)/i;
const ABORT_RE = /abort|AI_?Timeout|TimeoutError/i;
const BAD_OUTPUT_RE =
  /NoObjectGenerated|TypeValidation|JSONParse|No object generated|could not parse|invalid json/i;

/**
 * Normalize any thrown value into an {@link LlmProviderError}. Duck-typed (not
 * `instanceof`) so it handles AI SDK errors, fetch/undici errors, AbortError,
 * and plain objects from tests alike. `key` lets us scrub a leaked secret.
 */
export function mapProviderError(err: unknown, key?: string): LlmProviderError {
  if (err instanceof LlmProviderError) return err;

  const e = asRecord(err);
  const status = statusOf(e);
  const codeStr = codeStringOf(e);
  const detail = redactKey(
    typeof e.message === 'string' && e.message ? e.message : 'request failed',
    key,
  ).slice(0, 300);

  if (status === 401 || status === 403) {
    return new LlmProviderError(
      'PROVIDER_AUTH',
      'The provider rejected the API key — check it in Settings.',
    );
  }
  if (status === 404 || /model.*not.*found|no such model|unknown model/i.test(codeStr)) {
    return new LlmProviderError(
      'MODEL_NOT_FOUND',
      'The selected model was not found for this provider.',
    );
  }
  if (status === 429) {
    return new LlmProviderError('RATE_LIMITED', 'Rate limited by the provider.', retryAfterMsOf(e));
  }
  if (status === 408 || status === 504 || ABORT_RE.test(codeStr)) {
    return new LlmProviderError('TIMEOUT', 'The provider timed out.');
  }
  if (UNREACHABLE_RE.test(codeStr)) {
    return new LlmProviderError(
      'PROVIDER_UNREACHABLE',
      'Could not reach the provider — check the base URL, and that a local model server (e.g. Ollama) is running.',
    );
  }
  if (BAD_OUTPUT_RE.test(codeStr)) {
    return new LlmProviderError('BAD_OUTPUT', 'The model returned an unexpected response.');
  }
  if (typeof status === 'number' && status >= 500) {
    return new LlmProviderError('PROVIDER_ERROR', `The provider returned an error (${status}).`);
  }
  return new LlmProviderError('PROVIDER_ERROR', `Provider request failed: ${detail}`);
}
