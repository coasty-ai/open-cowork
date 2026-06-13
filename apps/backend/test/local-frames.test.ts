/**
 * Local-run live frames + SSE CORS — the two things that made the desktop
 * window show "Failed to fetch" and "Waiting for the first frame…".
 *
 * 1. SSE responses must carry Access-Control-Allow-Origin, because they're
 *    hijacked (the @fastify/cors onSend hook never runs) and the desktop hits
 *    the backend cross-origin (renderer :5173 → backend :4000).
 * 2. The local-run frame channel must round-trip the latest screen frame, be
 *    owner-isolated, reject non-local runs, and 404 unknown ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers';

let h: Harness | null = null;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h?.close();
  h = null;
});

// A tiny valid-looking base64 PNG payload (content doesn't matter to the store).
const FRAME = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'.repeat(4);

async function createLocalRun(harness: Harness): Promise<string> {
  const res = await harness.api('/api/local-runs', {
    method: 'POST',
    body: JSON.stringify({ task: 'organize my desktop' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('SSE CORS (desktop cross-origin)', () => {
  it('event streams include Access-Control-Allow-Origin echoing the request Origin', async () => {
    const id = await createLocalRun(h!);
    const controller = new AbortController();
    const res = await fetch(`${h!.backendUrl}/api/runs/${id}/events`, {
      headers: {
        Authorization: `Bearer ${h!.token}`,
        Accept: 'text/event-stream',
        Origin: 'http://127.0.0.1:5173', // the desktop/vite renderer origin
      },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('origin');
    controller.abort();
  });

  it('falls back to * when there is no Origin header', async () => {
    const id = await createLocalRun(h!);
    const controller = new AbortController();
    const res = await fetch(`${h!.backendUrl}/api/runs/${id}/events`, {
      headers: { Authorization: `Bearer ${h!.token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    controller.abort();
  });

  it('the global activity feed stream is also CORS-enabled', async () => {
    const controller = new AbortController();
    const res = await fetch(`${h!.backendUrl}/api/events`, {
      headers: {
        Authorization: `Bearer ${h!.token}`,
        Accept: 'text/event-stream',
        Origin: 'http://127.0.0.1:5173',
      },
      signal: controller.signal,
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    controller.abort();
  });
});

describe('local-run live frame channel', () => {
  it('returns nulls before any frame is posted', async () => {
    const id = await createLocalRun(h!);
    const frame = (await (await h!.api(`/api/local-runs/${id}/frame`)).json()) as {
      base64: string | null;
    };
    expect(frame.base64).toBeNull();
  });

  it('round-trips the latest frame (POST then GET returns it)', async () => {
    const id = await createLocalRun(h!);
    const post = await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: FRAME, width: 1920, height: 1080 }),
    });
    expect(post.status).toBe(200);
    const frame = (await (await h!.api(`/api/local-runs/${id}/frame`)).json()) as {
      base64: string;
      width: number;
      height: number;
      capturedAt: string;
    };
    expect(frame.base64).toBe(FRAME);
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1080);
    expect(frame.capturedAt).toBeTruthy();
  });

  it('keeps only the LATEST frame (newest wins)', async () => {
    const id = await createLocalRun(h!);
    await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: 'AAAA' + FRAME, width: 800, height: 600 }),
    });
    await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: 'BBBB' + FRAME, width: 1280, height: 720 }),
    });
    const frame = (await (await h!.api(`/api/local-runs/${id}/frame`)).json()) as {
      base64: string;
      width: number;
    };
    expect(frame.base64.startsWith('BBBB')).toBe(true);
    expect(frame.width).toBe(1280);
  });

  it('rejects an invalid frame body (422)', async () => {
    const id = await createLocalRun(h!);
    const res = await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: '', width: 0, height: -1 }),
    });
    expect(res.status).toBe(400); // ZodError → BAD_REQUEST
  });

  it('404s a cloud run or unknown id (the frame channel is local-only)', async () => {
    // unknown id
    const unknown = await h!.api('/api/local-runs/r_nope/frame');
    expect(unknown.status).toBe(404);
    const post = await h!.api('/api/local-runs/r_nope/frame', {
      method: 'POST',
      body: JSON.stringify({ base64: FRAME, width: 10, height: 10 }),
    });
    expect(post.status).toBe(404);
  });

  it('is owner-isolated: another user cannot read or write a frame', async () => {
    const id = await createLocalRun(h!);
    await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: FRAME, width: 100, height: 100 }),
    });
    // A second user (fresh token) must not see it.
    const other = await fetch(`${h!.backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@example.com' }),
    });
    const otherToken = ((await other.json()) as { token: string }).token;
    const read = await fetch(`${h!.backendUrl}/api/local-runs/${id}/frame`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(read.status).toBe(404);
  });

  it('accepts a large (multi-hundred-KB) frame without a 413 (bodyLimit raised)', async () => {
    const id = await createLocalRun(h!);
    const big = 'A'.repeat(2_000_000); // ~2MB base64 — well over Fastify's 1MB default
    const res = await h!.api(`/api/local-runs/${id}/frame`, {
      method: 'POST',
      body: JSON.stringify({ base64: big, width: 3840, height: 2160 }),
    });
    expect(res.status).toBe(200);
    const frame = (await (await h!.api(`/api/local-runs/${id}/frame`)).json()) as {
      base64: string;
    };
    expect(frame.base64.length).toBe(big.length);
  });
});
