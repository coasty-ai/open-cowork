/**
 * Runtime Coasty-API-key configuration endpoints.
 *
 * These build the server with an INJECTED fetch stub and an in-memory db, so
 * nothing ever touches the network or a real Coasty account. Only FAKE keys are
 * used. The status endpoint must return ONLY enums/booleans — never a key value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, LIVE_BASE_URL, MOCK_BASE_URL } from '../src/config';
import { buildServer, type BuiltServer } from '../src/server';

// FAKE keys only — never a real, billable key.
const FAKE_TEST_KEY = 'sk-coasty-test-deadbeef12345678';
const FAKE_LIVE_KEY = 'sk-coasty-live-deadbeef12345678';
const FAKE_LEGACY_KEY = 'cua_sk_deadbeef12345678';

let built: BuiltServer | null = null;
afterEach(async () => {
  await built?.app.close();
  built = null;
});

function quietConfig(env: NodeJS.ProcessEnv) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return loadConfig(env);
  } finally {
    warn.mockRestore();
  }
}

/**
 * Build a server whose CoastyClient uses a fetch stub that records the
 * X-API-Key + URL of every upstream call (so we can prove the running client
 * resolves the active credentials) and returns a benign JSON body.
 */
function buildWithStub(env: NodeJS.ProcessEnv) {
  const calls: { url: string; apiKey: string | undefined }[] = [];
  const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), apiKey: headers['X-API-Key'] });
    return new Response(JSON.stringify({ models: [], cua_versions: [], action_types: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const config = quietConfig(env);
  const server = buildServer({ config, fetchImpl });
  return { server, calls };
}

/** Boot, then log in to get an auth token (mirrors helpers.ts). */
async function bootAndLogin(env: NodeJS.ProcessEnv) {
  const { server, calls } = buildWithStub(env);
  built = server;
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
  const login = (await (
    await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com' }),
    })
  ).json()) as { token: string };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`,
        ...(init.headers ?? {}),
      },
    });
  return { server, calls, url, token: login.token, api };
}

const NO_KEY_SOURCE = new Set(['runtime', 'env', 'demo']);

describe('GET /api/config/coasty-key (status)', () => {
  it('demo mode (no env key) → configured:false, demoMode:true, mode:null, source:"demo"', async () => {
    const { url } = await bootAndLogin({ COWORK_DB_PATH: ':memory:' });
    // PUBLIC — no Authorization header needed.
    const res = await fetch(`${url}/api/config/coasty-key`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      configured: false,
      mode: null,
      demoMode: true,
      source: 'demo',
    });
  });

  it('with an env key → configured:true, mode matches prefix, source:"env"', async () => {
    for (const [key, mode] of [
      [FAKE_TEST_KEY, 'test'],
      [FAKE_LIVE_KEY, 'live'],
      [FAKE_LEGACY_KEY, 'legacy'],
    ] as const) {
      const { url } = await bootAndLogin({
        COASTY_API_KEY: key,
        COASTY_BASE_URL: MOCK_BASE_URL, // keep any stray call on the mock, never live
        COWORK_DB_PATH: ':memory:',
      });
      const body = (await (await fetch(`${url}/api/config/coasty-key`)).json()) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({ configured: true, mode, demoMode: false, source: 'env' });
      await built?.app.close();
      built = null;
    }
  });

  it('never leaks the key value or its literal prefix string', async () => {
    const { url } = await bootAndLogin({
      COASTY_API_KEY: FAKE_LIVE_KEY,
      COASTY_BASE_URL: MOCK_BASE_URL,
      COWORK_DB_PATH: ':memory:',
    });
    const text = await (await fetch(`${url}/api/config/coasty-key`)).text();
    expect(text).not.toContain('deadbeef');
    expect(text).not.toMatch(/sk-coasty-(live|test)-/);
    expect(text).not.toMatch(/cua_sk_/);
  });
});

describe('POST /api/config/coasty-key (set/rotate)', () => {
  it('requires auth (path is public for GET only)', async () => {
    const { url } = await bootAndLogin({ COWORK_DB_PATH: ':memory:' });
    const res = await fetch(`${url}/api/config/coasty-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: FAKE_TEST_KEY }),
    });
    expect(res.status).toBe(401);
  });

  it('a malformed key → 400 INVALID_KEY_FORMAT, status unchanged', async () => {
    const { api } = await bootAndLogin({ COWORK_DB_PATH: ':memory:' });
    const before = (await (await api('/api/config/coasty-key')).json()) as Record<string, unknown>;
    const res = await api('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'not-a-coasty-key' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_KEY_FORMAT');
    // Demo status untouched.
    const after = (await (await api('/api/config/coasty-key')).json()) as Record<string, unknown>;
    expect(after).toEqual(before);
  });

  it('a valid fake key → 200, GET then shows configured/runtime, client resolves the new key', async () => {
    // Boot in demo (no env key); explicitly pin the mock so the applied runtime
    // key targets the mock base URL, never the live API.
    const { server, calls, api } = await bootAndLogin({
      COASTY_BASE_URL: MOCK_BASE_URL,
      COWORK_DB_PATH: ':memory:',
    });

    const post = await api('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: FAKE_LIVE_KEY }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({
      ok: true,
      configured: true,
      mode: 'live',
      demoMode: false,
      source: 'runtime',
    });

    const status = (await (await api('/api/config/coasty-key')).json()) as Record<string, unknown>;
    expect(status).toEqual({
      configured: true,
      mode: 'live',
      demoMode: false,
      source: 'runtime',
    });

    // The shared credentials cell now holds the new key + base URL.
    expect(server.credentials.key).toBe(FAKE_LIVE_KEY);
    expect(server.credentials.baseUrl).toBe(MOCK_BASE_URL);
    expect(server.credentials.source).toBe('runtime');

    // The RUNNING client resolves the new key on its next call (no restart).
    calls.length = 0;
    await server.coasty.models();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe(FAKE_LIVE_KEY);
    expect(calls[0]!.url.startsWith(MOCK_BASE_URL)).toBe(true);

    // Persisted to the settings table (write-only).
    expect(server.db.getSetting('coasty_api_key')).toBe(FAKE_LIVE_KEY);
  });

  it('a valid runtime key with NO explicit base URL switches the client to LIVE_BASE_URL', async () => {
    // No COASTY_BASE_URL → runtime key must target LIVE. We assert the cell only;
    // we do NOT issue an upstream call (that would hit the real API).
    const { server, api } = await bootAndLogin({ COWORK_DB_PATH: ':memory:' });
    const post = await api('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: FAKE_LIVE_KEY }),
    });
    expect(post.status).toBe(200);
    expect(server.credentials.baseUrl).toBe(LIVE_BASE_URL);
    expect(server.credentials.key).toBe(FAKE_LIVE_KEY);
  });
});

describe('DELETE /api/config/coasty-key (clear)', () => {
  it('reverts to the env key when one is present', async () => {
    const { api, server } = await bootAndLogin({
      COASTY_API_KEY: FAKE_TEST_KEY,
      COASTY_BASE_URL: MOCK_BASE_URL,
      COWORK_DB_PATH: ':memory:',
    });
    // Override at runtime with a different fake key…
    await api('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: FAKE_LIVE_KEY }),
    });
    expect(server.credentials.source).toBe('runtime');
    // …then clear → back to the env key.
    const del = await api('/api/config/coasty-key', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({
      configured: true,
      mode: 'test',
      demoMode: false,
      source: 'env',
    });
    expect(server.credentials.key).toBe(FAKE_TEST_KEY);
    expect(server.db.getSetting('coasty_api_key')).toBeUndefined();
  });

  it('reverts to demo/mock when there is no env key', async () => {
    const { api, server } = await bootAndLogin({
      COASTY_BASE_URL: MOCK_BASE_URL,
      COWORK_DB_PATH: ':memory:',
    });
    await api('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: FAKE_TEST_KEY }),
    });
    const del = await api('/api/config/coasty-key', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { source: string; demoMode: boolean; configured: boolean };
    expect(body).toEqual({ configured: false, mode: null, demoMode: true, source: 'demo' });
    expect(server.credentials.demoMode).toBe(true);
    expect(NO_KEY_SOURCE.has(body.source)).toBe(true);
  });

  it('a persisted runtime key survives a "restart" (new buildServer over the same db file)', async () => {
    // Use a temp file db so a second buildServer sees the persisted row.
    const dbFile = `./data/test-config-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    try {
      const first = buildWithStub({ COASTY_BASE_URL: MOCK_BASE_URL, COWORK_DB_PATH: dbFile });
      first.server.db.setSetting('coasty_api_key', FAKE_LIVE_KEY);
      await first.server.app.close();

      const second = buildWithStub({ COASTY_BASE_URL: MOCK_BASE_URL, COWORK_DB_PATH: dbFile });
      built = second.server;
      // Boot precedence: persisted runtime key wins over (absent) env / demo.
      expect(second.server.credentials.source).toBe('runtime');
      expect(second.server.credentials.key).toBe(FAKE_LIVE_KEY);
      expect(second.server.credentials.baseUrl).toBe(MOCK_BASE_URL);
    } finally {
      const { rmSync } = await import('node:fs');
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(dbFile + suffix);
        } catch {
          // ignore
        }
      }
    }
  });
});
