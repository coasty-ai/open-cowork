/**
 * @open-cowork/mock-coasty — a faithful offline mock of the Coasty Computer
 * Use API (docs snapshot 2026-06-11): auth + key kinds, the error envelope,
 * documented pricing/billing simulation, run/workflow steppers with durable
 * SSE event replay, HMAC-signed webhooks, and sandbox machines. Used by every
 * automated test in the monorepo; it never bills anything real.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { MockState, type KeyKind } from './state';
import { sendError, requestId } from './util';
import { type Ctx, type MockOptions } from './ctx';
import { registerInferenceRoutes } from './inference';
import { registerRunRoutes } from './runs';
import { registerMachineRoutes } from './machines';
import { registerWorkflowRoutes } from './workflows';

export { buildSignature } from './util';
export { MockState } from './state';
export type { MockOptions } from './ctx';
export { validateDefinition } from './workflows';
export { parsePyautogui } from './inference';

export interface MockCoasty {
  app: FastifyInstance;
  state: MockState;
}

function classifyKey(key: string | undefined): KeyKind | null {
  if (!key) return null;
  if (/^sk-coasty-test-[0-9a-fA-F]{8,}$/.test(key)) return 'test';
  if (/^sk-coasty-live-[0-9a-fA-F]{8,}$/.test(key)) return 'live';
  if (/^cua_sk_[0-9a-fA-F]{8,}$/.test(key)) return 'legacy';
  return null;
}

export function createMockCoasty(options: Partial<MockOptions> = {}): MockCoasty {
  const opts: MockOptions = {
    walletCents: options.walletCents ?? 10_000,
    tickMs: options.tickMs ?? 25,
    defaultRunSteps: options.defaultRunSteps ?? 4,
    logger: options.logger ?? false,
  };
  const state = new MockState(opts.walletCents);
  const ctx: Ctx = { state, opts };

  // forceCloseConnections: open SSE streams must not block app.close().
  const app = Fastify({ logger: opts.logger, forceCloseConnections: true });

  // Tolerate an application/json content-type with an empty body (clients send
  // bare POST/DELETE; the real API accepts them).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if ((body as string).length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ── auth + documented headers on every /v1 response ────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1')) return;
    const headerKey = request.headers['x-api-key'];
    const auth = request.headers.authorization;
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const raw = (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? bearer;
    const kind = classifyKey(raw);
    if (!kind) {
      return sendError(reply, 401, 'INVALID_API_KEY', 'Missing, malformed, or revoked API key');
    }
    request.keyKind = kind;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/v1')) return payload;
    if (!reply.getHeader('X-Coasty-Request-Id')) void reply.header('X-Coasty-Request-Id', requestId());
    if (request.keyKind) {
      void reply.header('X-Coasty-Key-Kind', request.keyKind);
      if (request.keyKind === 'test') void reply.header('X-Coasty-Test-Mode', 'true');
    }
    return payload;
  });

  registerInferenceRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);

  app.setNotFoundHandler((request, reply) => {
    void sendError(reply, 404, 'NOT_FOUND', `No route for ${request.method} ${request.url}`);
  });

  app.addHook('onClose', async () => {
    state.clearTimers();
  });

  return { app, state };
}
