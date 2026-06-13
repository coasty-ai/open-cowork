/**
 * buildServer — assembles the open-cowork backend:
 *  - bearer-token auth (demo single-tenant; see SECURITY.md)
 *  - Coasty proxy routes (the API key lives ONLY here)
 *  - HMAC-verified webhook receiver
 *  - SQLite persistence + SSE fan-out with Last-Event-ID replay
 *  - server-side cost estimates + budget caps with the confirmCostCents handshake
 *
 * Dependencies are injected for testability; integration tests run the whole
 * server against an in-process mock-coasty.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomBytes } from 'node:crypto';
import { CoastyApiError, CoastyClient } from '@open-cowork/core';
import { ZodError } from 'zod';
import type { BackendConfig } from './config';
import { Db, type UserRow } from './db';
import { EventBus } from './bus';
import { Ingestor } from './ingest';
import { AppError, unauthorized } from './errors';
import { registerRunRoutes } from './routes/runs';
import { registerWorkflowRoutes } from './routes/workflows';
import { registerMachineRoutes } from './routes/machines';
import { registerWebhookRoutes } from './routes/webhooks';
import {
  registerConfigRoutes,
  resolveBootCredentials,
  type CoastyCredentials,
} from './routes/config';
import { streamSse } from './sse';
import { z } from 'zod';
import {
  machineRuntimeCentsPerHour,
  runEstimateCents,
  workflowEstimateCents,
} from '@open-cowork/core';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow;
    rawBody?: string;
  }
}

export interface ServerDeps {
  config: BackendConfig;
  /** Injectable fetch for the CoastyClient (tests). */
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: Db;
  bus: EventBus;
  coasty: CoastyClient;
  ingestor: Ingestor;
  /**
   * The live, mutable Coasty credentials the shared client resolves on every
   * call. Runtime key changes mutate this in place. Exposed for tests/inspection
   * — its `key` is a secret and must never be serialized to a client.
   */
  credentials: CoastyCredentials;
}

export function buildServer(deps: ServerDeps): BuiltServer {
  const { config } = deps;
  const db = new Db(config.dbPath);
  const bus = new EventBus();
  // The one source of truth for the active Coasty credentials. Boot precedence:
  // persisted runtime key > env key (when not demo) > demo (ephemeral + mock).
  const credentials = resolveBootCredentials(config, db);
  // Construct the single CoastyClient with GETTERS reading the cell, so the
  // Ingestor and every route (which share this client) pick up a runtime key
  // change on their next call — no restart, no reconstruction.
  const coasty = new CoastyClient({
    baseUrl: () => credentials.baseUrl,
    apiKey: () => credentials.key,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 60_000,
  });
  const ingestor = new Ingestor(coasty, db, bus);

  // forceCloseConnections: long-lived SSE responses must not block shutdown.
  // bodyLimit 16MB: local-run screenshots (proxied predict + live frames) are
  // full-screen PNGs that routinely exceed Fastify's 1MB default — without this
  // the desktop's predict/frame POSTs would 413 and local runs would stall.
  const app = Fastify({
    logger: deps.logger ?? false,
    forceCloseConnections: true,
    bodyLimit: 16 * 1024 * 1024,
  });

  // Capture the raw body (webhook HMAC verification needs the exact bytes).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    if ((body as string).length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON'), undefined);
    }
  });

  void app.register(cors, { origin: true, exposedHeaders: ['Content-Type'] });

  // ── auth hook ───────────────────────────────────────────────────────────────
  // GET /api/config/coasty-key is public so the login screen can show demo /
  // configured state pre-auth. POST/DELETE on that path still require auth (the
  // hook only exempts the path for non-mutating reads — see below).
  const PUBLIC_PATHS = new Set(['/api/auth/login', '/health', '/api/config/coasty-key']);
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? request.url;
    // The coasty-key status is public for GET only; POST/DELETE (mutations) must
    // be authenticated even though the path is in PUBLIC_PATHS for reads.
    const isPublic =
      PUBLIC_PATHS.has(path) && !(path === '/api/config/coasty-key' && request.method !== 'GET');
    if (isPublic || path.startsWith('/webhooks/')) return;
    if (!path.startsWith('/api/')) return;
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = token ? db.userForToken(token) : undefined;
    if (!user) throw unauthorized();
    request.user = user;
  });

  // ── error mapping ───────────────────────────────────────────────────────────
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.status).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    if (err instanceof CoastyApiError) {
      // Propagate Coasty's status + code; the request_id makes support possible.
      void reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: err.requestId,
          details: err.details,
        },
      });
      return;
    }
    if (err instanceof ZodError) {
      const fields = err.issues.map((i) => i.path.join('.') || '(body)');
      void reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `Request validation failed: ${[...new Set(fields)].join(', ')}`,
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const maybeStatus = (err as { statusCode?: unknown }).statusCode;
    const status = typeof maybeStatus === 'number' ? maybeStatus : 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    void reply.status(status).send({
      error: { code: 'INTERNAL_ERROR', message: status >= 500 ? 'Internal error' : message },
    });
  });

  // ── health + auth + me + wallet + estimate ─────────────────────────────────
  app.get('/health', async () => ({ ok: true }));

  const loginSchema = z.object({ email: z.string().email() });
  app.post('/api/auth/login', async (request) => {
    const { email } = loginSchema.parse(request.body);
    const user = db.upsertUser(email, config.defaultBudgetCents);
    const token = `cwk_${randomBytes(32).toString('hex')}`;
    db.createSession(user.id, token, config.sessionTtlSeconds);
    return {
      token,
      user: { id: user.id, email: user.email, budgetCents: user.budget_cents },
    };
  });

  app.get('/api/me', async (request) => {
    const user = request.user;
    return {
      user: { id: user.id, email: user.email, budgetCents: user.budget_cents },
      monthSpendCents: db.monthSpendCents(user.id),
    };
  });

  const budgetSchema = z.object({ budgetCents: z.number().int().min(1).max(1_000_000) });
  app.patch('/api/me/budget', async (request) => {
    const { budgetCents } = budgetSchema.parse(request.body);
    db.setUserBudget(request.user.id, budgetCents);
    return { budgetCents };
  });

  app.get('/api/wallet', async (request) => {
    // The Coasty wallet (usage()) needs the `usage` scope, which is NOT on a
    // default key. Degrade gracefully so the wallet card shows "unavailable"
    // (with the reason) instead of failing — local month-spend is always shown.
    const monthSpendCents = db.monthSpendCents(request.user.id);
    try {
      const usage = await coasty.usage();
      return {
        balanceCents: usage.wallet_balance_cents ?? usage.balance,
        periodCostCents: usage.total_cost_cents,
        period: usage.period,
        monthSpendCents,
        breakdown: usage.breakdown,
        walletAvailable: true,
      };
    } catch (err) {
      const reason =
        err instanceof CoastyApiError && err.code === 'INSUFFICIENT_SCOPE'
          ? "the key is missing the 'usage' scope"
          : 'the Coasty usage endpoint is unavailable';
      return {
        balanceCents: null,
        periodCostCents: null,
        period: null,
        monthSpendCents,
        breakdown: {},
        walletAvailable: false,
        walletUnavailableReason: reason,
      };
    }
  });

  const estimateSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('run'),
      cuaVersion: z.enum(['v1', 'v3', 'v4']).optional(),
      maxSteps: z.number().int().min(1).max(1000).optional(),
    }),
    z.object({
      kind: z.literal('machine'),
      osType: z.enum(['linux', 'windows']).optional(),
    }),
    z.object({
      kind: z.literal('workflow'),
      definition: z.record(z.string(), z.unknown()),
      cuaVersion: z.enum(['v1', 'v3', 'v4']).optional(),
      assumedStepsPerTask: z.number().int().min(1).max(100).optional(),
    }),
  ]);
  app.post('/api/estimate', async (request) => {
    const body = estimateSchema.parse(request.body);
    switch (body.kind) {
      case 'run': {
        const est = runEstimateCents({ cuaVersion: body.cuaVersion, maxSteps: body.maxSteps });
        return { kind: 'run', cents: est.maxCents, breakdown: est };
      }
      case 'machine': {
        const rate = machineRuntimeCentsPerHour(body.osType ?? 'linux', 'running');
        return {
          kind: 'machine',
          cents: rate,
          breakdown: { centsPerHour: rate, stoppedCentsPerHour: 1 },
        };
      }
      case 'workflow': {
        const est = workflowEstimateCents(body.definition as never, {
          cuaVersion: body.cuaVersion,
          assumedStepsPerTask: body.assumedStepsPerTask,
        });
        return { kind: 'workflow', cents: est.typicalCents, breakdown: est };
      }
    }
  });

  // ── global per-user activity feed (replay + live via 'notification' stream) ─
  app.get('/api/events', (request, reply) => {
    streamSse(request, reply, {
      db,
      bus,
      streamKind: 'notification',
      streamId: request.user.id,
      closeOnType: '__never__',
    });
  });

  // ── feature routes ──────────────────────────────────────────────────────────
  registerRunRoutes(app, { config, db, bus, coasty, ingestor });
  registerWorkflowRoutes(app, { config, db, bus, coasty, ingestor });
  registerMachineRoutes(app, { config, db, coasty });
  registerWebhookRoutes(app, { db, bus });
  registerConfigRoutes(app, { config, db, credentials });

  // Resume ingestion for runs that were live when the server last stopped.
  app.addHook('onReady', async () => {
    for (const row of db.sql
      .prepare(
        `SELECT id, coasty_run_id, user_id FROM runs
         WHERE kind = 'coasty' AND status NOT IN ('succeeded','failed','cancelled','timed_out')`,
      )
      .all() as unknown as { id: string; coasty_run_id: string; user_id: string }[]) {
      ingestor.start({
        kind: 'run',
        localId: row.id,
        coastyId: row.coasty_run_id,
        userId: row.user_id,
      });
    }
    for (const row of db.sql
      .prepare(
        `SELECT id, coasty_workflow_run_id, user_id FROM workflow_runs
         WHERE status NOT IN ('succeeded','failed','cancelled','timed_out')`,
      )
      .all() as unknown as { id: string; coasty_workflow_run_id: string; user_id: string }[]) {
      ingestor.start({
        kind: 'workflow-run',
        localId: row.id,
        coastyId: row.coasty_workflow_run_id,
        userId: row.user_id,
      });
    }
  });

  app.addHook('onClose', async () => {
    ingestor.dispose();
    db.close();
  });

  return { app, db, bus, coasty, ingestor, credentials };
}
