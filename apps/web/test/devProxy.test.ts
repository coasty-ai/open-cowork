/**
 * Dev/preview proxy behavior (../dev-proxy.ts): target resolution from env, the
 * clean 503 the SPA receives when the backend is down, throttled logging, and
 * the configure hook that de-noises Vite's default ECONNREFUSED handler.
 *
 * Pure unit tests — no real Vite server, no sockets. The proxy module is
 * self-contained on purpose, so we exercise it with small structural fakes for
 * the http response / socket / proxy-server surfaces.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_UNREACHABLE_CODE,
  DEFAULT_BACKEND_PORT,
  buildProxyConfig,
  createProxyErrorHandler,
  resolveBackendTarget,
  sendUnreachable,
  unreachableBody,
  type ProxyErrorListener,
  type ProxyErrorTarget,
  type ProxyHttpResponse,
  type ProxyServerLike,
} from '../dev-proxy';

// --- fakes -----------------------------------------------------------------

interface FakeResponse extends ProxyHttpResponse {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeResponse(
  overrides: Partial<Pick<ProxyHttpResponse, 'headersSent' | 'writableEnded'>> = {},
): FakeResponse {
  return {
    headersSent: overrides.headersSent ?? false,
    writableEnded: overrides.writableEnded ?? false,
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function makeSocket() {
  return { destroy: vi.fn() };
}

/** A minimal EventEmitter standing in for http-proxy's Server. */
function makeFakeProxy(): ProxyServerLike & {
  listeners: Record<string, ProxyErrorListener[]>;
  emit: (event: string, err: unknown, req: unknown, res: ProxyErrorTarget) => void;
} {
  const listeners: Record<string, ProxyErrorListener[]> = {};
  return {
    listeners,
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    removeAllListeners(event) {
      if (event) delete listeners[event];
      else for (const key of Object.keys(listeners)) delete listeners[key];
      return this;
    },
    emit(event, err, req, res) {
      for (const listener of listeners[event] ?? []) {
        listener(err as never, req, res);
      }
    },
  };
}

// --- resolveBackendTarget --------------------------------------------------

describe('resolveBackendTarget', () => {
  it('defaults to localhost on the default backend port', () => {
    expect(resolveBackendTarget({})).toBe(`http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
    expect(DEFAULT_BACKEND_PORT).toBe(4000);
  });

  it('honors a custom COWORK_PORT', () => {
    expect(resolveBackendTarget({ COWORK_PORT: '4100' })).toBe('http://127.0.0.1:4100');
  });

  it('trims whitespace around COWORK_PORT', () => {
    expect(resolveBackendTarget({ COWORK_PORT: '  4200 ' })).toBe('http://127.0.0.1:4200');
  });

  it.each(['0', '-1', '70000', 'abc', '', '   '])(
    'falls back to the default port for invalid COWORK_PORT %j',
    (bad) => {
      expect(resolveBackendTarget({ COWORK_PORT: bad })).toBe(
        `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
      );
    },
  );

  it('prefers an explicit COWORK_BACKEND_URL over COWORK_PORT', () => {
    expect(
      resolveBackendTarget({ COWORK_BACKEND_URL: 'http://10.0.0.5:9000', COWORK_PORT: '4100' }),
    ).toBe('http://10.0.0.5:9000');
  });

  it('strips trailing slashes from COWORK_BACKEND_URL', () => {
    expect(resolveBackendTarget({ COWORK_BACKEND_URL: 'https://api.example.com/' })).toBe(
      'https://api.example.com',
    );
  });

  it('ignores a blank COWORK_BACKEND_URL and falls through to the port', () => {
    expect(resolveBackendTarget({ COWORK_BACKEND_URL: '   ', COWORK_PORT: '4300' })).toBe(
      'http://127.0.0.1:4300',
    );
  });
});

// --- unreachableBody -------------------------------------------------------

describe('unreachableBody', () => {
  it('is valid JSON shaped like the backend error envelope', () => {
    const parsed = JSON.parse(unreachableBody('http://127.0.0.1:4000')) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe(BACKEND_UNREACHABLE_CODE);
    expect(parsed.error.code).toBe('BACKEND_UNREACHABLE');
    expect(parsed.error.message).toContain('http://127.0.0.1:4000');
    expect(parsed.error.message).toMatch(/running/i);
  });
});

// --- sendUnreachable -------------------------------------------------------

describe('sendUnreachable', () => {
  it('writes a 503 JSON response when headers are not yet sent', () => {
    const res = makeResponse();
    sendUnreachable(res, 'http://127.0.0.1:4000');
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    const [status, headers] = res.writeHead.mock.calls[0]! as [number, Record<string, string>];
    expect(status).toBe(503);
    expect(headers['Content-Type']).toMatch(/application\/json/);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(res.end).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.end.mock.calls[0]![0] as string) as { error: { code: string } };
    expect(body.error.code).toBe('BACKEND_UNREACHABLE');
  });

  it('does not set headers if they were already sent (mid-stream SSE), but still ends', () => {
    const res = makeResponse({ headersSent: true });
    sendUnreachable(res, 'http://127.0.0.1:4000');
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the response is already finished', () => {
    const res = makeResponse({ writableEnded: true });
    sendUnreachable(res, 'http://127.0.0.1:4000');
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('destroys a raw socket (websocket upgrade) instead of writing HTTP', () => {
    const socket = makeSocket();
    sendUnreachable(socket, 'http://127.0.0.1:4000');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when there is no response object', () => {
    expect(() => sendUnreachable(undefined, 'http://127.0.0.1:4000')).not.toThrow();
  });
});

// --- createProxyErrorHandler ----------------------------------------------

describe('createProxyErrorHandler', () => {
  it('answers the pending request with the clean 503', () => {
    const handler = createProxyErrorHandler('http://127.0.0.1:4000', { log: vi.fn() });
    const res = makeResponse();
    handler({ code: 'ECONNREFUSED' }, {}, res);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('logs a single actionable line including the target and the error reason', () => {
    const log = vi.fn();
    const handler = createProxyErrorHandler('http://127.0.0.1:4321', { log, now: () => 0 });
    handler({ code: 'ECONNREFUSED' }, {}, makeResponse());
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('http://127.0.0.1:4321');
    expect(line).toContain('ECONNREFUSED');
    expect(line).toMatch(/pnpm dev/);
  });

  it('falls back to the error message when there is no code', () => {
    const log = vi.fn();
    const handler = createProxyErrorHandler('http://127.0.0.1:4000', { log, now: () => 0 });
    handler({ message: 'socket hang up' }, {}, makeResponse());
    expect(log.mock.calls[0]![0]).toContain('socket hang up');
  });

  it('throttles repeated notices but still answers every request', () => {
    const log = vi.fn();
    let clock = 0;
    const handler = createProxyErrorHandler('http://127.0.0.1:4000', {
      log,
      now: () => clock,
      throttleMs: 5_000,
    });
    const responses: FakeResponse[] = [];
    const fire = () => {
      const res = makeResponse();
      responses.push(res);
      handler({ code: 'ECONNREFUSED' }, {}, res);
    };

    clock = 0;
    fire(); // logs
    clock = 100;
    fire(); // muted (within window)
    clock = 4_999;
    fire(); // muted (boundary, < window)
    clock = 5_000;
    fire(); // logs again (>= window)

    expect(log).toHaveBeenCalledTimes(2);
    // ...but every single request got its 503, throttled or not.
    expect(responses).toHaveLength(4);
    for (const res of responses) {
      expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
      expect(res.end).toHaveBeenCalledTimes(1);
    }
  });
});

// --- buildProxyConfig ------------------------------------------------------

describe('buildProxyConfig', () => {
  it('builds an /api entry targeting the resolved backend with changeOrigin', () => {
    const config = buildProxyConfig({ env: { COWORK_PORT: '4100' }, log: vi.fn() });
    const entry = config['/api'];
    expect(entry).toBeDefined();
    expect(entry!.target).toBe('http://127.0.0.1:4100');
    expect(entry!.changeOrigin).toBe(true);
    expect(typeof entry!.configure).toBe('function');
  });

  // The swap is deferred to a microtask (Vite ≥6 attaches its 'error' handler
  // AFTER configure returns), so flush microtasks before asserting.
  const flushMicrotasks = () => Promise.resolve();

  it("configure() replaces Vite's noisy 'error' handler attached AFTER it (Vite ≥6 order)", async () => {
    const log = vi.fn();
    const config = buildProxyConfig({ env: {}, log });
    const proxy = makeFakeProxy();

    config['/api']!.configure(proxy);
    // Vite 6 wires its stack-trace logger AFTER configure returns, before the
    // deferred swap runs.
    const viteNoisyHandler = vi.fn();
    proxy.on('error', viteNoisyHandler as unknown as ProxyErrorListener);
    expect(proxy.listeners.error).toHaveLength(1);

    await flushMicrotasks();

    // Exactly one 'error' listener remains, and it is NOT Vite's.
    expect(proxy.listeners.error).toHaveLength(1);
    expect(proxy.listeners.error![0]).not.toBe(viteNoisyHandler);

    // Emitting an error now drives our handler: friendly log + clean 503,
    // and Vite's noisy handler never fires.
    const res = makeResponse();
    proxy.emit('error', { code: 'ECONNREFUSED' }, {}, res);
    expect(viteNoisyHandler).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("configure() also replaces a noisy 'error' handler attached BEFORE it (Vite ≤5 order)", async () => {
    const config = buildProxyConfig({ env: {}, log: vi.fn() });
    const proxy = makeFakeProxy();

    // Older Vite attaches its handler before calling configure.
    const viteNoisyHandler = vi.fn();
    proxy.on('error', viteNoisyHandler as unknown as ProxyErrorListener);

    config['/api']!.configure(proxy);
    await flushMicrotasks();

    expect(proxy.listeners.error).toHaveLength(1);
    expect(proxy.listeners.error![0]).not.toBe(viteNoisyHandler);
    const res = makeResponse();
    proxy.emit('error', { code: 'ECONNREFUSED' }, {}, res);
    expect(viteNoisyHandler).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  });

  it('defaults to the default backend port when env is empty', () => {
    const config = buildProxyConfig({ env: {} });
    expect(config['/api']!.target).toBe(`http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
  });
});
