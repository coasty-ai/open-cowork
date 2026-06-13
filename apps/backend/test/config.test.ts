/**
 * The one-key setup contract, pinned. `loadConfig` must:
 *  - need NOTHING but (optionally) COASTY_API_KEY
 *  - fall into demo mode (mock base URL + ephemeral sandbox key) with no env
 *  - auto-generate a session secret when none is given
 *  - resolve the right base URL for sandbox vs live keys
 *  - reject only a genuinely malformed key
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, LIVE_BASE_URL, MOCK_BASE_URL } from '../src/config';

const SANDBOX = `sk-coasty-test-${'a'.repeat(48)}`;
const LIVE = `sk-coasty-live-${'b'.repeat(48)}`;
const LEGACY = `cua_sk_${'c'.repeat(48)}`;

function quietLoad(env: NodeJS.ProcessEnv) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return loadConfig(env);
  } finally {
    warn.mockRestore();
  }
}

describe('loadConfig — one-key contract', () => {
  it('boots with a COMPLETELY empty environment (demo mode)', () => {
    const cfg = quietLoad({});
    expect(cfg.demoMode).toBe(true);
    expect(cfg.sandbox).toBe(true);
    expect(cfg.coastyBaseUrl).toBe(MOCK_BASE_URL);
    expect(cfg.coastyApiKey).toMatch(/^sk-coasty-test-[0-9a-f]{48}$/);
    // a usable session secret was synthesized
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(16);
    // sensible defaults
    expect(cfg.port).toBe(4000);
    expect(cfg.defaultBudgetCents).toBe(500);
    expect(cfg.dbPath).toBe('./data/cowork.sqlite');
  });

  it('a single sandbox key is enough — talks to the REAL Coasty API, no secret needed', () => {
    const cfg = quietLoad({ COASTY_API_KEY: SANDBOX });
    expect(cfg.demoMode).toBe(false);
    expect(cfg.sandbox).toBe(true);
    expect(cfg.coastyBaseUrl).toBe(LIVE_BASE_URL);
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(16);
  });

  it('a single live key resolves to the live API and is flagged non-sandbox', () => {
    const cfg = quietLoad({ COASTY_API_KEY: LIVE });
    expect(cfg.demoMode).toBe(false);
    expect(cfg.sandbox).toBe(false);
    expect(cfg.coastyBaseUrl).toBe(LIVE_BASE_URL);
  });

  it('accepts a legacy cua_sk_ key', () => {
    const cfg = quietLoad({ COASTY_API_KEY: LEGACY });
    expect(cfg.sandbox).toBe(false);
    expect(cfg.demoMode).toBe(false);
  });

  it('generates a fresh session secret each boot when none is provided', () => {
    const a = quietLoad({ COASTY_API_KEY: SANDBOX });
    const b = quietLoad({ COASTY_API_KEY: SANDBOX });
    expect(a.sessionSecret).not.toBe(b.sessionSecret);
  });

  it('honors an explicit session secret (durable sessions in production)', () => {
    const secret = 'a-very-stable-production-secret-value';
    const cfg = quietLoad({ COASTY_API_KEY: SANDBOX, COWORK_SESSION_SECRET: secret });
    expect(cfg.sessionSecret).toBe(secret);
  });

  it('respects an explicit COASTY_BASE_URL override (e.g. pin the mock with a real key)', () => {
    const cfg = quietLoad({ COASTY_API_KEY: SANDBOX, COASTY_BASE_URL: MOCK_BASE_URL });
    expect(cfg.coastyBaseUrl).toBe(MOCK_BASE_URL);
    expect(cfg.demoMode).toBe(false); // a key was supplied
  });

  it('coerces numeric env values and clamps via schema', () => {
    const cfg = quietLoad({
      COASTY_API_KEY: SANDBOX,
      COWORK_PORT: '5555',
      COWORK_DEFAULT_BUDGET_CENTS: '1200',
      COWORK_SESSION_TTL_SECONDS: '3600',
    });
    expect(cfg.port).toBe(5555);
    expect(cfg.defaultBudgetCents).toBe(1200);
    expect(cfg.sessionTtlSeconds).toBe(3600);
  });

  it('treats whitespace-only / empty key as absent → demo mode', () => {
    expect(quietLoad({ COASTY_API_KEY: '   ' }).demoMode).toBe(true);
    expect(quietLoad({ COASTY_API_KEY: '' }).demoMode).toBe(true);
  });

  it('rejects a malformed (but present) key', () => {
    expect(() => quietLoad({ COASTY_API_KEY: 'not-a-coasty-key' })).toThrow(/COASTY_API_KEY/);
    expect(() => quietLoad({ COASTY_API_KEY: 'sk-coasty-prod-xyz' })).toThrow(/COASTY_API_KEY/);
  });

  it('rejects a session secret that is too short when explicitly set', () => {
    expect(() => quietLoad({ COASTY_API_KEY: SANDBOX, COWORK_SESSION_SECRET: 'short' })).toThrow(
      /sessionSecret/,
    );
  });

  it('warns (does not throw) for a live key on a non-https public URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({ COASTY_API_KEY: LIVE, COWORK_PUBLIC_URL: 'http://example.com' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not https'));
    warn.mockRestore();
  });
});

describe('loadConfig — webhookUrl gating (Coasty requires HTTPS)', () => {
  it('REAL Coasty + non-https public URL → no webhook (the bug that 422d every run)', () => {
    // The exact default: a real key + default http://127.0.0.1:4000. Sending an
    // http webhook_url made the real Coasty API reject every run creation.
    const cfg = quietLoad({ COASTY_API_KEY: LIVE });
    expect(cfg.coastyBaseUrl).toBe(LIVE_BASE_URL);
    expect(cfg.webhookUrl).toBeNull();
  });

  it('REAL Coasty + https public URL → webhook registered', () => {
    const cfg = quietLoad({
      COASTY_API_KEY: LIVE,
      COWORK_PUBLIC_URL: 'https://cowork.example.com',
    });
    expect(cfg.webhookUrl).toBe('https://cowork.example.com/webhooks/coasty');
  });

  it('sandbox key against real Coasty + non-https public URL → no webhook', () => {
    const cfg = quietLoad({ COASTY_API_KEY: SANDBOX });
    expect(cfg.coastyBaseUrl).toBe(LIVE_BASE_URL);
    expect(cfg.webhookUrl).toBeNull();
  });

  it('local mock upstream → webhook kept even over http (mock accepts it; tests rely on it)', () => {
    const cfg = quietLoad({ COASTY_API_KEY: SANDBOX, COASTY_BASE_URL: MOCK_BASE_URL });
    expect(cfg.webhookUrl).toBe('http://127.0.0.1:4000/webhooks/coasty');
  });

  it('demo mode (no key, mock base URL) → webhook kept', () => {
    const cfg = quietLoad({});
    expect(cfg.demoMode).toBe(true);
    expect(cfg.webhookUrl).toBe('http://127.0.0.1:4000/webhooks/coasty');
  });

  it('localhost / 127.0.0.1 / [::1] upstreams are all treated as the local mock', () => {
    for (const base of [
      'http://localhost:4010/v1',
      'http://127.0.0.1:9999/v1',
      'http://[::1]:4010/v1',
    ]) {
      expect(
        quietLoad({ COASTY_API_KEY: SANDBOX, COASTY_BASE_URL: base }).webhookUrl,
      ).not.toBeNull();
    }
  });

  it('a custom https public URL with a real upstream registers that exact URL', () => {
    const cfg = quietLoad({
      COASTY_API_KEY: LIVE,
      COWORK_PUBLIC_URL: 'https://my.tunnel.example:8443',
    });
    expect(cfg.webhookUrl).toBe('https://my.tunnel.example:8443/webhooks/coasty');
  });
});
