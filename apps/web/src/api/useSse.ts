/**
 * React hook for backend SSE streams with automatic reconnect via
 * Last-Event-ID and an online/offline indicator. fetch-based (EventSource
 * cannot send Authorization headers); frames parsed with core's SSE parser.
 */
import { useEffect, useRef, useState } from 'react';
import { parseSseStream } from '@open-cowork/core';
import type { BackendClient } from './client';

export interface SseEventItem {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface UseSseOptions {
  client: BackendClient;
  path: string | null; // null disables the stream
  onEvent?: (event: SseEventItem) => void;
  /** Stop reconnecting after this event type (server closes too). */
  closeOnType?: string;
  maxReconnects?: number;
}

export interface UseSseResult {
  events: SseEventItem[];
  connected: boolean;
  finished: boolean;
  error: string | null;
}

export function useSse(opts: UseSseOptions): UseSseResult {
  const { client, path, closeOnType = 'done', maxReconnects = 20 } = opts;
  const [events, setEvents] = useState<SseEventItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  useEffect(() => {
    if (!path) return;
    setEvents([]);
    setFinished(false);
    setError(null);

    const controller = new AbortController();
    let cursor = 0;
    let reconnects = 0;
    let stopped = false;

    const connect = async (): Promise<void> => {
      while (!stopped && reconnects <= maxReconnects) {
        try {
          const res = await fetch(client.url(path), {
            headers: {
              Accept: 'text/event-stream',
              ...client.authHeaders(),
              ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
            },
            signal: controller.signal,
          });
          // A 401 means the session is gone — stop, don't hammer with retries.
          // (The page's REST calls clear the session and bounce to login.)
          if (res.status === 401) {
            setConnected(false);
            setError('unauthorized');
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
          setConnected(true);
          setError(null);
          for await (const frame of parseSseStream(res.body)) {
            const seq = Number(frame.id ?? cursor + 1);
            if (seq <= cursor) continue;
            cursor = seq;
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(frame.data || '{}') as Record<string, unknown>;
            } catch {
              data = { raw: frame.data };
            }
            const item: SseEventItem = { seq, type: frame.event ?? 'message', data };
            setEvents((prev) => [...prev, item]);
            onEventRef.current?.(item);
            if (item.type === closeOnType) {
              setFinished(true);
              setConnected(false);
              return;
            }
          }
          // Stream ended without the terminal event: reconnect from cursor.
          setConnected(false);
          reconnects++;
          await sleep(Math.min(500 * 2 ** reconnects, 5000), controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          setConnected(false);
          setError(err instanceof Error ? err.message : 'stream error');
          reconnects++;
          try {
            await sleep(Math.min(500 * 2 ** reconnects, 5000), controller.signal);
          } catch {
            return;
          }
        }
      }
    };
    void connect();

    return () => {
      stopped = true;
      controller.abort();
      setConnected(false);
    };
  }, [path]);

  return { events, connected, finished, error };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
