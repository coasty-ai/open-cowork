import { describe, expect, it } from 'vitest';
import { CoastyProvider } from '../src/coastyProvider';
import { LlmProviderError } from '../src/errors';

interface Rec {
  method: string;
  path: string;
  body: unknown;
  auth?: string;
  signal?: AbortSignal | null;
}

/** A fake backend proxy recording requests and answering the session/predict API. */
function fakeBackend(opts: { failStatus?: number } = {}) {
  const calls: Rec[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
      signal: init?.signal,
    });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (opts.failStatus) return json({ error: { message: 'nope' } }, opts.failStatus);
    if (method === 'POST' && path === '/api/proxy/sessions') {
      return json({ session_id: 'sess_1', cua_version: 'v3', screen_size: '1280x720' });
    }
    if (method === 'POST' && path === '/api/proxy/sessions/sess_1/predict') {
      return json({
        request_id: 'r1',
        session_id: 'sess_1',
        step: 1,
        status: 'continue',
        reasoning: 'clicking',
        actions: [{ action_type: 'click', params: { x: 1, y: 2 } }],
        usage: { credits_charged: 4, cost_cents: 4 },
      });
    }
    if (method === 'DELETE' && path === '/api/proxy/sessions/sess_1')
      return json({ deleted: true });
    return json({ error: { message: `unmatched ${method} ${path}` } }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const input = (over = {}) => ({
  screenshotB64: 'AAAA',
  instruction: 'open the menu',
  stepIndex: 0,
  width: 1280,
  height: 720,
  ...over,
});

describe('CoastyProvider — wraps the backend proxy (default path)', () => {
  it('beginRun → predict → endRun hits the exact proxy endpoints in order', async () => {
    const backend = fakeBackend();
    const p = new CoastyProvider({
      backendUrl: 'http://backend.test',
      getToken: () => 'tok_1',
      fetchImpl: backend.fetchImpl,
      cuaVersion: 'v3',
    });
    await p.beginRun({ task: 'open the menu', width: 1280, height: 720 });
    const res = await p.predict(input());
    await p.endRun();

    expect(backend.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/proxy/sessions',
      'POST /api/proxy/sessions/sess_1/predict',
      'DELETE /api/proxy/sessions/sess_1',
    ]);
    expect(backend.calls[0]!.body).toMatchObject({ screenWidth: 1280, screenHeight: 720 });
    expect(backend.calls[1]!.body).toMatchObject({
      screenshot: 'AAAA',
      instruction: 'open the menu',
    });
    expect(res).toEqual({
      status: 'continue',
      reasoning: 'clicking',
      actions: [{ action_type: 'click', params: { x: 1, y: 2 } }],
      usage: { credits_charged: 4, cost_cents: 4 },
    });
    expect(backend.calls.every((c) => c.auth === 'Bearer tok_1')).toBe(true);
  });

  it('threads the abort signal into the predict fetch (cancellation works)', async () => {
    const backend = fakeBackend();
    const p = new CoastyProvider({
      backendUrl: 'http://b',
      getToken: () => 't',
      fetchImpl: backend.fetchImpl,
    });
    const ac = new AbortController();
    await p.beginRun({ task: 't', width: 10, height: 10 });
    await p.predict(input(), { signal: ac.signal });
    const predictCall = backend.calls.find((c) => c.path.endsWith('/predict'))!;
    expect(predictCall.signal).toBe(ac.signal);
  });

  it('predict without beginRun lazily creates a session', async () => {
    const backend = fakeBackend();
    const p = new CoastyProvider({
      backendUrl: 'http://b',
      getToken: () => 't',
      fetchImpl: backend.fetchImpl,
    });
    await p.predict(input());
    expect(backend.calls[0]!.path).toBe('/api/proxy/sessions');
    expect(backend.calls[1]!.path).toBe('/api/proxy/sessions/sess_1/predict');
  });

  it('endRun is idempotent and best-effort', async () => {
    const backend = fakeBackend();
    const p = new CoastyProvider({
      backendUrl: 'http://b',
      getToken: () => 't',
      fetchImpl: backend.fetchImpl,
    });
    await p.endRun(); // no session yet → no call
    await p.beginRun({ task: 't', width: 10, height: 10 });
    await p.endRun();
    await p.endRun(); // second time → no-op
    expect(backend.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('maps a 401 to PROVIDER_AUTH', async () => {
    const backend = fakeBackend({ failStatus: 401 });
    const p = new CoastyProvider({
      backendUrl: 'http://b',
      getToken: () => 't',
      fetchImpl: backend.fetchImpl,
    });
    await expect(p.beginRun({ task: 't', width: 10, height: 10 })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
  });

  it('maps a network failure to PROVIDER_UNREACHABLE', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    }) as typeof fetch;
    const p = new CoastyProvider({ backendUrl: 'http://b', getToken: () => 't', fetchImpl });
    await expect(p.beginRun({ task: 't', width: 1, height: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
    });
  });

  it('lists CUA versions (all vision) and reports healthy', async () => {
    const p = new CoastyProvider({ backendUrl: 'http://b', getToken: () => 't' });
    const models = await p.listModels();
    expect(models.every((m) => m.vision === true)).toBe(true);
    expect(models.map((m) => m.id)).toContain('v3');
    expect((await p.health()).ok).toBe(true);
    expect(p.kind).toBe('coasty');
    expect(p.model).toBe('v3');
  });

  it('wraps an LlmProviderError already (no double-wrap)', async () => {
    const p = new CoastyProvider({
      backendUrl: 'http://b',
      getToken: () => 't',
      fetchImpl: fakeBackend({ failStatus: 404 }).fetchImpl,
    });
    const err = await p.beginRun({ task: 't', width: 1, height: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
  });
});
