/**
 * Integration-test harness: a real backend listening on localhost wired to an
 * in-process mock-coasty (also listening, so SSE + webhook delivery are real
 * HTTP). Everything is offline and free — the mock never bills anything.
 */
import { createServer } from 'node:net';
import { createMockCoasty } from '@open-cowork/mock-coasty';
import { parseSseStream } from '@open-cowork/core';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltServer } from '../src/server';

export const TEST_KEY = `sk-coasty-test-${'a'.repeat(48)}`;
/** A live-STYLE key for wallet-simulation tests. Only ever sent to the local mock. */
export const LIVE_STYLE_KEY = `sk-coasty-live-${'b'.repeat(48)}`;

export interface Harness {
  backendUrl: string;
  mock: ReturnType<typeof createMockCoasty>;
  built: BuiltServer;
  token: string;
  /** Authorized fetch against the backend. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

export interface HarnessOptions {
  apiKey?: string;
  walletCents?: number;
  defaultBudgetCents?: number;
  mockOpts?: Parameters<typeof createMockCoasty>[0];
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const mock = createMockCoasty({
    tickMs: 5,
    defaultRunSteps: 3,
    walletCents: opts.walletCents,
    ...opts.mockOpts,
  });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const mockPort = (mock.app.server.address() as { port: number }).port;

  const backendPort = await freePort();
  const config = loadConfig({
    COASTY_API_KEY: opts.apiKey ?? TEST_KEY,
    COASTY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    COWORK_PORT: String(backendPort),
    COWORK_PUBLIC_URL: `http://127.0.0.1:${backendPort}`,
    COWORK_DB_PATH: ':memory:',
    COWORK_SESSION_SECRET: 'integration-test-secret-32-chars!!',
    COWORK_DEFAULT_BUDGET_CENTS: String(opts.defaultBudgetCents ?? 500),
  } as NodeJS.ProcessEnv);

  const built = buildServer({ config });
  await built.app.listen({ port: backendPort, host: '127.0.0.1' });
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  const loginRes = await fetch(`${backendUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tester@example.com' }),
  });
  const { token } = (await loginRes.json()) as { token: string };

  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${backendUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  return {
    backendUrl,
    mock,
    built,
    token,
    api,
    close: async () => {
      await built.app.close();
      await mock.app.close();
    },
  };
}

/** Poll until `fn` returns truthy or time runs out. */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 8000,
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export interface CollectedEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/** Collect SSE events from a backend stream until `until` matches or the stream ends. */
export async function collectSse(
  url: string,
  token: string,
  opts: { lastEventId?: number; until?: (e: CollectedEvent) => boolean; maxMs?: number } = {},
): Promise<CollectedEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxMs ?? 8000);
  const events: CollectedEvent[] = [];
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        ...(opts.lastEventId ? { 'Last-Event-ID': String(opts.lastEventId) } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE request failed: ${res.status}`);
    for await (const frame of parseSseStream(res.body)) {
      const event: CollectedEvent = {
        seq: Number(frame.id ?? 0),
        type: frame.event ?? 'message',
        data: JSON.parse(frame.data || '{}') as Record<string, unknown>,
      };
      events.push(event);
      if (opts.until?.(event) || event.type === 'done') break;
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}
