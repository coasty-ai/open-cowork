/**
 * useSse in isolation: SSE frames accumulate, connected flips true, mid-stream
 * errors reconnect with Last-Event-ID, and unmount aborts the fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useSse } from '../src/api/useSse';
import { stubClient, encodeSseFrames, sseStream } from './helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSse', () => {
  it('accumulates events and flips connected true, then finishes on closeOnType', async () => {
    const body = encodeSseFrames([
      { id: 1, event: 'status', data: { status: 'running' } },
      { id: 2, event: 'step', data: { steps_completed: 1 } },
      { id: 3, event: 'done', data: { status: 'succeeded' } },
    ]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: sseStream(body) }));
    vi.stubGlobal('fetch', fetchMock);

    const client = stubClient();
    const { result } = renderHook(() =>
      useSse({ client, path: '/api/runs/r1/events', closeOnType: 'done' }),
    );

    await waitFor(() => expect(result.current.finished).toBe(true));
    expect(result.current.events).toHaveLength(3);
    expect(result.current.events.map((e) => e.type)).toEqual(['status', 'step', 'done']);
    expect(result.current.connected).toBe(false); // done flips it back off
    // The terminal event never reconnects.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('disables the stream entirely when path is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = stubClient();
    const { result } = renderHook(() => useSse({ client, path: null }));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.events).toHaveLength(0);
  });

  it('reconnects after a mid-stream error and sends Last-Event-ID from the cursor', async () => {
    vi.useFakeTimers();
    const client = stubClient();

    // First stream: emit 2 frames then error the body mid-stream.
    const firstBody: ReadableStream<Uint8Array> = (() => {
      const enc = new TextEncoder();
      const frames = encodeSseFrames([
        { id: 1, event: 'status', data: { status: 'running' } },
        { id: 2, event: 'step', data: { steps_completed: 1 } },
      ]);
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(enc.encode(frames));
            sent = true;
          } else {
            controller.error(new Error('connection reset'));
          }
        },
      });
    })();

    const secondBody = sseStream(
      encodeSseFrames([{ id: 3, event: 'done', data: { status: 'succeeded' } }]),
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: firstBody })
      .mockResolvedValueOnce({ ok: true, status: 200, body: secondBody });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useSse({ client, path: '/api/runs/r1/events', closeOnType: 'done' }),
    );

    // Wait for the first stream's error to register (reconnect scheduled via timer).
    await vi.waitFor(() => expect(result.current.error).toBe('connection reset'));
    expect(result.current.events).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the backoff sleep so the reconnect fires.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The second fetch must carry Last-Event-ID = the last consumed seq (2).
    const [, secondCallInit] = fetchMock.mock.calls[1]! as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(secondCallInit.headers['Last-Event-ID']).toBe('2');

    await vi.waitFor(() => expect(result.current.finished).toBe(true));
    // 2 frames from the first stream + the done frame from the second.
    expect(result.current.events).toHaveLength(3);
  });

  it('does NOT send Last-Event-ID on the very first connection', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream(encodeSseFrames([{ id: 1, event: 'done', data: {} }])),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = stubClient();
    const { result } = renderHook(() =>
      useSse({ client, path: '/api/runs/r1/events', closeOnType: 'done' }),
    );
    await waitFor(() => expect(result.current.finished).toBe(true));
    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['Last-Event-ID']).toBeUndefined();
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers.Authorization).toBe('Bearer cwk_t');
  });

  it('aborts the fetch on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    // A body that never resolves so the stream stays open until aborted.
    const neverEnding = new ReadableStream<Uint8Array>({ pull() {} });
    const fetchMock = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      return { ok: true, status: 200, body: neverEnding };
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = stubClient();
    const { result, unmount } = renderHook(() => useSse({ client, path: '/api/runs/r1/events' }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('sets an error when the response is not ok', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, body: null }));
    vi.stubGlobal('fetch', fetchMock);
    const client = stubClient();
    const { result } = renderHook(() =>
      useSse({ client, path: '/api/runs/r1/events', maxReconnects: 0 }),
    );
    await vi.waitFor(() => expect(result.current.error).toContain('503'));
    expect(result.current.connected).toBe(false);
  });
});
