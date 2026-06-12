/**
 * SSE responder: replays stored events with seq > Last-Event-ID (or ?after=),
 * then streams live ones; ends after a 'done' event, exactly like the docs.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MockState, StoredEvent } from './state';

export function streamEvents(
  state: MockState,
  streamId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const header = request.headers['last-event-id'];
  const after = Number(
    (Array.isArray(header) ? header[0] : header) ??
      (request.query as Record<string, string | undefined>).after ??
      0,
  );
  const cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let lastSent = cursor;
  let closed = false;

  const write = (event: StoredEvent): void => {
    if (closed || event.seq <= lastSent) return;
    reply.raw.write(
      `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
    lastSent = event.seq;
    if (event.type === 'done') end();
  };

  const unsubscribe = state.subscribe(streamId, (event) => {
    // Fill any gap from the store first (live event may have raced replay).
    for (const stored of state.eventsAfter(streamId, lastSent)) {
      if (stored.seq >= event.seq) break;
      write(stored);
    }
    write(event);
  });

  function end(): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    reply.raw.end();
  }

  request.raw.on('close', end);

  for (const event of state.eventsAfter(streamId, cursor)) {
    write(event);
    if (closed) return;
  }
}
