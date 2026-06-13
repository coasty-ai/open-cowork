/**
 * Dev/preview proxy for the web SPA.
 *
 * The SPA talks to the backend with same-origin `/api/*` URLs; in `vite dev`
 * and `vite preview` this module forwards them to the open-cowork backend.
 *
 * The thing it fixes: when the backend isn't up yet (you ran `pnpm dev:web`
 * alone, or it's still starting), Vite's built-in proxy prints a full
 * `ECONNREFUSED` stack trace for *every* request — runs, machines, events,
 * estimate, and the SSE stream all retry, so the console floods. Worse, the
 * browser request just hangs/fails with no usable response.
 *
 * Here we replace Vite's error handler with one that (a) logs a single,
 * throttled, actionable line instead of a stack-trace storm and (b) answers the
 * pending request with a clean `503 { error: { code: 'BACKEND_UNREACHABLE' }}`
 * the SPA already knows how to render (see api/client.ts).
 *
 * It's deliberately self-contained — no `vite`/`node:*` type imports — because
 * it's loaded both by `vite.config.ts` (Node) and by the vitest suite (jsdom,
 * which has no `@types/node`). It declares the handful of runtime shapes it
 * needs instead of pulling in type packages the web app doesn't otherwise use.
 */

// `process` is a Node global available wherever Vite evaluates the config. The
// web tsconfig is DOM-only (no @types/node), so declare the slice we read.
// (This file never ships to the browser — only vite.config.ts imports it.)
declare const process: { env: Record<string, string | undefined> };

/** Backend port used when nothing overrides it (matches apps/backend config). */
export const DEFAULT_BACKEND_PORT = 4000;

/** Stable error code the SPA matches on (see api/client.ts isBackendUnreachable). */
export const BACKEND_UNREACHABLE_CODE = 'BACKEND_UNREACHABLE';

type Env = Record<string, string | undefined>;

/**
 * Resolve the backend origin `/api` is forwarded to. Honors, in order:
 *   1. `COWORK_BACKEND_URL` — an explicit absolute origin (the desktop shell
 *      and deployments set this).
 *   2. `COWORK_PORT` — the backend's port on localhost (the dev runner sets
 *      this from `.env`); falls back to {@link DEFAULT_BACKEND_PORT}.
 *
 * Previously the proxy hard-coded `:4000`, so changing `COWORK_PORT` silently
 * pointed the SPA at the wrong port — a real source of `ECONNREFUSED`.
 */
export function resolveBackendTarget(env: Env = process.env): string {
  const explicit = (env.COWORK_BACKEND_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const raw = (env.COWORK_PORT ?? '').trim();
  const port = Number.parseInt(raw, 10);
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;
  return `http://127.0.0.1:${valid ? port : DEFAULT_BACKEND_PORT}`;
}

/** The slice of `http.ServerResponse` the error path touches. */
export interface ProxyHttpResponse {
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: string): unknown;
}

/** The slice of `net.Socket` (a websocket-upgrade target) the error path touches. */
export interface ProxySocket {
  destroy(error?: Error): unknown;
}

/** http-proxy hands the error handler either an HTTP response or a raw socket. */
export type ProxyErrorTarget = ProxyHttpResponse | ProxySocket | undefined;

/** The bits of the thrown proxy error we read (`Error` plus a Node `code`). */
export interface ProxyErrorLike {
  code?: string;
  message?: string;
}

export type ProxyErrorListener = (err: ProxyErrorLike, req: unknown, res: ProxyErrorTarget) => void;

function isHttpResponse(res: ProxyErrorTarget): res is ProxyHttpResponse {
  return !!res && typeof (res as ProxyHttpResponse).writeHead === 'function';
}

/** The JSON body the SPA receives when the backend is unreachable. */
export function unreachableBody(target: string): string {
  return JSON.stringify({
    error: {
      code: BACKEND_UNREACHABLE_CODE,
      message:
        `The open-cowork backend at ${target} is not reachable yet. Is it running? ` +
        'Start the full stack with `pnpm dev` (backend + web) or `pnpm desktop`.',
    },
  });
}

/**
 * Answer a request whose proxy target refused the connection. For an HTTP
 * request we send a clean `503` JSON the SPA can render; for a websocket
 * upgrade (a raw socket, nothing useful to write) we just close it. Safe to
 * call when headers are already sent (e.g. an SSE stream that dropped
 * mid-flight) or the response is already finished.
 */
export function sendUnreachable(res: ProxyErrorTarget, target: string): void {
  if (isHttpResponse(res)) {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }
    res.end(unreachableBody(target));
    return;
  }
  if (res && typeof (res as ProxySocket).destroy === 'function') {
    (res as ProxySocket).destroy();
  }
}

export interface ProxyErrorHandlerDeps {
  /** Where the throttled notice goes (default `console.warn`). */
  log?: (message: string) => void;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** How long to mute repeat notices, ms (default 5000). */
  throttleMs?: number;
}

/**
 * Build the `'error'` listener installed on the proxy: one throttled, friendly
 * log line + a clean 503 to the waiting request. Throttling matters because
 * the SPA fires several requests (and an auto-reconnecting SSE stream) at once,
 * so a down backend would otherwise log many identical lines per second.
 */
export function createProxyErrorHandler(
  target: string,
  deps: ProxyErrorHandlerDeps = {},
): ProxyErrorListener {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => Date.now());
  const throttleMs = deps.throttleMs ?? 5_000;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  return (err, _req, res) => {
    const at = now();
    if (at - lastWarnAt >= throttleMs) {
      lastWarnAt = at;
      const reason = err?.code ?? err?.message ?? 'connection failed';
      log(
        `[open-cowork] /api → ${target} is not reachable (${reason}). ` +
          'Is the backend running? Start it with `pnpm dev` (backend + web) or ' +
          `\`pnpm desktop\`. Muting repeats for ${Math.round(throttleMs / 1000)}s.`,
      );
    }
    sendUnreachable(res, target);
  };
}

/** The minimal http-proxy server surface our `configure` hook drives. */
export interface ProxyServerLike {
  on(event: 'error', listener: ProxyErrorListener): unknown;
  removeAllListeners(event?: string): unknown;
}

/** A single `/api` proxy entry, shaped to slot into Vite's `server.proxy`. */
export interface DevProxyEntry {
  target: string;
  changeOrigin: boolean;
  configure: (proxy: ProxyServerLike) => void;
}

export interface BuildProxyDeps extends ProxyErrorHandlerDeps {
  env?: Env;
}

/**
 * The `/api` proxy table shared by `server` and `preview` in vite.config.ts.
 * The `configure` hook swaps Vite's noisy default `'error'` handler for ours.
 */
export function buildProxyConfig(deps: BuildProxyDeps = {}): Record<string, DevProxyEntry> {
  const target = resolveBackendTarget(deps.env);
  const onError = createProxyErrorHandler(target, deps);
  return {
    '/api': {
      target,
      changeOrigin: true,
      configure: (proxy) => {
        // Vite installs its own 'error' listener that logs a full stack trace
        // per failed request (the ECONNREFUSED flood). Depending on the Vite
        // version that happens BEFORE this hook (≤5) or AFTER it (6: configure
        // runs first, then `proxy.on('error', …)`), so removing it inline is
        // unreliable. Defer to a microtask instead: Node drains microtasks
        // before any incoming request (a macrotask), so by the time the proxy
        // serves anything, Vite's listener is attached and we've replaced it
        // with ours — order-agnostic. We only touch the 'error' event, leaving
        // Vite's proxyReq/proxyRes/ws listeners intact.
        queueMicrotask(() => {
          proxy.removeAllListeners('error');
          proxy.on('error', onError);
        });
      },
    },
  };
}
