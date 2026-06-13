/**
 * BackendClient request pipeline: URL building, auth-header injection, JSON
 * decoding, ApiError shaping from error bodies, and NETWORK_ERROR wrapping —
 * all via an injected fetchImpl (no real network).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, BackendClient, defaultBaseUrl, formatApiError } from '../src/api/client';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Reset any injected desktop shell.
  delete (window as { cowork?: unknown }).cowork;
});

describe('formatApiError', () => {
  it('appends the code, offending fields, and upstream request id', () => {
    const err = new ApiError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      [{ path: 'webhook_url', message: 'must be https' }],
      'req_abc123',
    );
    const text = formatApiError(err);
    expect(text).toContain('Request validation failed');
    expect(text).toContain('[VALIDATION_ERROR]');
    expect(text).toContain('webhook_url');
    expect(text).toContain('req_abc123');
  });

  it('does not duplicate a code already present in the message', () => {
    const err = new ApiError(402, 'INSUFFICIENT_CREDITS', 'INSUFFICIENT_CREDITS: top up');
    expect(formatApiError(err)).toBe('INSUFFICIENT_CREDITS: top up');
  });

  it('passes plain Errors through and handles non-errors', () => {
    expect(formatApiError(new Error('boom'))).toBe('boom');
    expect(formatApiError('weird')).toBe('Unexpected error');
  });
});

describe('BackendClient 401 auto-logout (onUnauthorized)', () => {
  it('fires onUnauthorized on a 401 from an authenticated route', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'UNAUTHORIZED' } }, { ok: false, status: 401 }),
    );
    const client = new BackendClient({
      baseUrl: 'http://b',
      getToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onUnauthorized for a 401 on the login route', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'UNAUTHORIZED' } }, { ok: false, status: 401 }),
    );
    const client = new BackendClient({
      baseUrl: 'http://b',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    });
    await expect(client.login('x@y.z')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does NOT fire onUnauthorized for non-401 errors', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'BAD' } }, { ok: false, status: 500 }),
    );
    const client = new BackendClient({
      baseUrl: 'http://b',
      getToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('BackendClient.url / authHeaders', () => {
  it('prepends the base URL and strips trailing slashes', () => {
    const client = new BackendClient({ baseUrl: 'https://api.example.com/', getToken: () => null });
    expect(client.url('/api/me')).toBe('https://api.example.com/api/me');
  });

  it('returns an Authorization header only when a token is present', () => {
    const withToken = new BackendClient({ getToken: () => 'cwk_abc' });
    expect(withToken.authHeaders()).toEqual({ Authorization: 'Bearer cwk_abc' });
    const without = new BackendClient({ getToken: () => null });
    expect(without.authHeaders()).toEqual({});
  });
});

describe('defaultBaseUrl', () => {
  it('uses the desktop shell backendUrl when present', () => {
    (window as { cowork?: { platform: string; backendUrl: string } }).cowork = {
      platform: 'desktop',
      backendUrl: 'https://desktop.local',
    };
    expect(defaultBaseUrl()).toBe('https://desktop.local');
  });

  it('falls back to same-origin (empty string) on the web', () => {
    expect(defaultBaseUrl()).toBe('');
  });
});

describe('BackendClient.request pipeline', () => {
  it('sends JSON + auth headers and decodes the response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ user: { id: 'u1', email: 'a@b.c', budgetCents: 500 }, monthSpendCents: 0 }),
    );
    const client = new BackendClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const me = await client.me();
    expect(me.user.email).toBe('a@b.c');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/me');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('serializes the body for POST endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ kind: 'run', cents: 10, breakdown: {} }));
    const client = new BackendClient({
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.estimate({ kind: 'run', maxSteps: 25 });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'run', maxSteps: 25 });
  });

  it('throws a shaped ApiError from a structured error body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'BUDGET_EXCEEDED', message: 'too pricey', details: { cap: 100 } } },
        { ok: false, status: 422 },
      ),
    );
    const client = new BackendClient({
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getRun('r1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      code: 'BUDGET_EXCEEDED',
      message: 'too pricey',
      details: { cap: 100 },
    });
  });

  it('falls back to UNKNOWN when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));
    const client = new BackendClient({
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.listRuns().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNKNOWN');
    expect((err as ApiError).message).toContain('500');
  });

  it('wraps a fetch rejection as NETWORK_ERROR (status 0)', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')));
    const client = new BackendClient({
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.wallet().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('builds the right method/URL for resume, cancel, and DELETE endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new BackendClient({
      baseUrl: 'https://api.test',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.resumeRun('r9', 'note');
    await client.cancelRun('r9');
    await client.terminateMachine('m3');
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe('https://api.test/api/runs/r9/resume');
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ note: 'note' });
    expect(calls[1]![0]).toBe('https://api.test/api/runs/r9/cancel');
    expect(calls[2]![0]).toBe('https://api.test/api/machines/m3');
    expect(calls[2]![1].method).toBe('DELETE');
  });
});
