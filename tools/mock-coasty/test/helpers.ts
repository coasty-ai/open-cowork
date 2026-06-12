import { createMockCoasty, type MockCoasty } from '../src/index';

/** Structural subset of fastify's inject() response we use in tests. */
export interface MockResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json<T = unknown>(): T;
}

export const TEST_KEY = `sk-coasty-test-${'a'.repeat(48)}`;
export const LIVE_KEY = `sk-coasty-live-${'b'.repeat(48)}`;
export const LEGACY_KEY = `cua_sk_${'c'.repeat(48)}`;
export const SCREENSHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'.repeat(8); // >100 chars, no data: prefix

export function mock(opts: Parameters<typeof createMockCoasty>[0] = {}): MockCoasty {
  return createMockCoasty({ tickMs: 5, defaultRunSteps: 3, ...opts });
}

export interface InjectOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  key?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(
  m: MockCoasty,
  path: string,
  opts: InjectOpts = {},
): Promise<MockResponse> {
  const res = await m.app.inject({
    method: opts.method ?? 'GET',
    url: path,
    headers: {
      ...(opts.key === null ? {} : { 'x-api-key': opts.key ?? TEST_KEY }),
      // Only declare a JSON body when one is actually sent — fastify rejects
      // an application/json content-type with an empty body.
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
  return res as unknown as MockResponse;
}

export async function createMachine(m: MockCoasty, key = TEST_KEY): Promise<string> {
  const res = await call(m, '/v1/machines', {
    method: 'POST',
    key,
    body: { display_name: 'test-vm', os_type: 'linux', desktop_enabled: true },
  });
  if (res.statusCode !== 201) throw new Error(`machine create failed: ${res.body}`);
  return (res.json() as { machine: { id: string } }).machine.id;
}

export async function pollUntil<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 6000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('pollUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
