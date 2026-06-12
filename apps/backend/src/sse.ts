/**
 * SSE response helper for Fastify routes. Replays persisted events first
 * (everything after the client's Last-Event-ID), then streams live bus events.
 * The connection closes after a terminal `done` event (matching Coasty).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db';
import type { BusEvent, EventBus } from './bus';

export interface SseStreamOptions {
  db: Db;
  bus: EventBus;
  streamKind: string;
  streamId: string;
  /** Close the stream after an event of this type is sent. */
  closeOnType?: string;
  /** Heartbeat comment interval; keeps proxies from buffering. Default 15s. */
  heartbeatMs?: number;
}

export function lastEventIdOf(request: FastifyRequest): number {
  const header = request.headers['last-event-id'];
  const query = (request.query as Record<string, string | undefined>)?.after;
  const raw = (Array.isArray(header) ? header[0] : header) ?? query ?? '0';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function streamSse(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: SseStreamOptions,
): void {
  const { db, bus, streamKind, streamId, closeOnType = 'done', heartbeatMs = 15_000 } = opts;

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let lastSent = lastEventIdOf(request);
  let closed = false;

  const write = (seq: number, type: string, dataJson: string): void => {
    if (closed) return;
    reply.raw.write(`id: ${seq}\nevent: ${type}\ndata: ${dataJson}\n\n`);
    lastSent = seq;
    if (type === closeOnType) end();
  };

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': heartbeat\n\n');
  }, heartbeatMs);

  const unsubscribe = bus.subscribeStream(streamKind, streamId, (event: BusEvent) => {
    if (event.seq <= lastSent) return;
    // Gap fill: if live events jumped ahead of what we've sent, read the gap from the DB.
    if (event.seq > lastSent + 1) {
      for (const row of db.eventsAfter(streamKind, streamId, lastSent)) {
        if (row.seq >= event.seq) break;
        write(row.seq, row.type, row.data_json);
      }
    }
    write(event.seq, event.type, JSON.stringify(event.data));
  });

  function end(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  }

  request.raw.on('close', end);

  // Replay everything the client missed, then live events take over.
  for (const row of db.eventsAfter(streamKind, streamId, lastSent)) {
    write(row.seq, row.type, row.data_json);
    if (closed) return;
  }
}
