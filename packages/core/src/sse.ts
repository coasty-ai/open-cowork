/**
 * Minimal, spec-correct Server-Sent Events parser over a byte stream.
 * Handles chunk boundaries mid-line, CRLF/LF, multi-line `data:`, comment lines,
 * and `id:`/`event:` fields. Isomorphic (Web Streams + TextDecoder only).
 */

export interface SseEvent {
  /** Last seen `id:` field at dispatch time (sticky across events per spec). */
  id?: string;
  /** `event:` field; absent means the default ("message") event. */
  event?: string;
  /** All `data:` lines joined with `\n`. */
  data: string;
}

/**
 * Parse a ReadableStream of UTF-8 bytes into SSE events.
 * The trailing partial event (no terminating blank line) is NOT dispatched,
 * matching the EventSource spec.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();

  let buffer = '';
  let dataLines: string[] = [];
  let eventType: string | undefined;
  let lastId: string | undefined;

  function* drainLines(flush: boolean): Generator<SseEvent> {
    // Process complete lines in the buffer; keep the trailing partial line.
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // Dispatch if any data accumulated.
        if (dataLines.length > 0) {
          yield { id: lastId, event: eventType, data: dataLines.join('\n') };
        }
        dataLines = [];
        eventType = undefined;
        continue;
      }
      if (line.startsWith(':')) continue; // comment

      let field: string;
      let value: string;
      const colon = line.indexOf(':');
      if (colon === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
      }
      switch (field) {
        case 'data':
          dataLines.push(value);
          break;
        case 'event':
          eventType = value;
          break;
        case 'id':
          // Per spec, ids containing NUL are ignored.
          if (!value.includes('\0')) lastId = value;
          break;
        default:
          // 'retry' and unknown fields are ignored by this parser.
          break;
      }
    }
    if (flush) {
      // Spec: an event is only dispatched on a blank line; partial tail is dropped.
      buffer = '';
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainLines(false);
    }
    buffer += decoder.decode(); // flush decoder
    yield* drainLines(true);
  } finally {
    reader.releaseLock();
  }
}
