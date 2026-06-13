/**
 * Entrypoint coverage for src/main.ts. We mock buildServer so no real port is
 * bound and exercise both the demo-mode and live-key console banners plus the
 * .env loader, all deterministically and offline. The SIGINT/SIGTERM shutdown
 * path is driven directly (without letting it actually exit the test process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);

vi.mock('../src/server', () => ({
  buildServer: vi.fn(() => ({ app: { listen, close, server: { address: () => ({ port: 0 }) } } })),
}));

const ORIGINAL_ENV = { ...process.env };
let cwd = '';

beforeEach(() => {
  vi.resetModules();
  listen.mockClear();
  close.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  if (cwd) {
    process.chdir(ORIGINAL_CWD);
    rmSync(cwd, { recursive: true, force: true });
    cwd = '';
  }
});

const ORIGINAL_CWD = process.cwd();

describe('main entrypoint', () => {
  it('boots in demo mode with an empty environment and prints the demo banner', async () => {
    // Strip every COASTY/COWORK var so loadConfig falls into demo mode.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('COASTY_') || k.startsWith('COWORK_')) delete process.env[k];
    }
    // Run from a temp dir with no .env so loadDotenv finds nothing.
    cwd = mkdtempSync(join(tmpdir(), 'cowork-main-'));
    process.chdir(cwd);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await import('../src/main');
    // Let the top-level void main() promise settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(listen).toHaveBeenCalledTimes(1);
    const banner = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(banner).toContain('listening at');
    expect(banner).toContain('DEMO MODE');

    log.mockRestore();
    warn.mockRestore();
  });

  it('reads a repo .env, boots with a live key, and prints the upstream banner', async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('COASTY_') || k.startsWith('COWORK_')) delete process.env[k];
    }
    cwd = mkdtempSync(join(tmpdir(), 'cowork-main-'));
    process.chdir(cwd);
    // A live-style key + explicit secret via .env exercises the dotenv loader and
    // the non-demo banner branch.
    writeFileSync(
      join(cwd, '.env'),
      [
        `COASTY_API_KEY=sk-coasty-live-${'b'.repeat(48)}`,
        'COWORK_SESSION_SECRET=a-stable-session-secret-value-32!',
        '# a comment line',
        'MALFORMED_LINE_WITHOUT_EQUALS',
        '',
      ].join('\n'),
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await import('../src/main');
    await new Promise((r) => setTimeout(r, 20));

    expect(listen).toHaveBeenCalledTimes(1);
    expect(process.env.COASTY_API_KEY).toContain('sk-coasty-live-');
    const banner = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(banner).toContain('Coasty upstream');
    expect(banner).toContain('LIVE');

    log.mockRestore();
    warn.mockRestore();
  });
});
