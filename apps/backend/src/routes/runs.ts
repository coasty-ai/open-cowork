/**
 * Run routes: delegate a task to a Coasty machine (cloud runs), mirror desktop
 * LocalExecutor runs (local runs), supervise both (list/get/cancel/resume),
 * and stream their event timelines over SSE.
 *
 * Spend safety: every cloud run requires the confirmCostCents handshake — the
 * client must echo the server-computed worst-case estimate — and the estimate
 * must fit inside the user's budget cap. Both checks are server-side.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isTerminalRunStatus,
  runEstimateCents,
  type CoastyClient,
  type Run,
  type RunStatus,
} from '@open-cowork/core';
import type { BackendConfig } from '../config';
import type { Db, RunRow } from '../db';
import type { EventBus } from '../bus';
import type { Ingestor } from '../ingest';
import { AppError, notFound } from '../errors';
import { streamSse } from '../sse';

export interface RunRouteDeps {
  config: BackendConfig;
  db: Db;
  bus: EventBus;
  coasty: CoastyClient;
  ingestor: Ingestor;
}

export interface RunDto {
  id: string;
  kind: 'coasty' | 'local';
  machineId: string | null;
  task: string;
  status: string;
  cuaVersion: string;
  maxSteps: number;
  budgetCents: number;
  costCents: number;
  stepsCompleted: number;
  result: unknown;
  error: unknown;
  awaitingHumanReason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function runToDto(row: RunRow): RunDto {
  return {
    id: row.id,
    kind: row.kind,
    machineId: row.machine_id,
    task: row.task,
    status: row.status,
    cuaVersion: row.cua_version,
    maxSteps: row.max_steps,
    budgetCents: row.budget_cents,
    costCents: row.cost_cents,
    stepsCompleted: row.steps_completed,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    awaitingHumanReason: row.awaiting_human_reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const TERMINAL = new Set<string>(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const { config, db, bus, coasty, ingestor } = deps;

  const publishNotification = (userId: string, type: string, data: Record<string, unknown>): void => {
    const seq = db.appendEvent('notification', userId, type, data);
    bus.publish({
      streamKind: 'notification',
      streamId: userId,
      seq,
      type,
      data,
      userId,
      createdAt: new Date().toISOString(),
    });
  };

  const syncRowFromCoasty = (row: RunRow, run: Run): RunRow => {
    db.updateRun(row.id, {
      status: run.status,
      cost_cents: run.cost_cents,
      steps_completed: run.steps_completed,
      result_json: run.result ? JSON.stringify(run.result) : null,
      error_json: run.error ? JSON.stringify(run.error) : null,
      awaiting_human_reason: run.awaiting_human_reason,
      finished_at: run.finished_at,
    });
    return { ...row, status: run.status, cost_cents: run.cost_cents, steps_completed: run.steps_completed };
  };

  // ── create a cloud run ──────────────────────────────────────────────────────
  const createSchema = z.object({
    machineId: z.string().min(1).max(128),
    task: z.string().min(1).max(16000),
    cuaVersion: z.enum(['v1', 'v3', 'v4']).default('v3'),
    maxSteps: z.number().int().min(1).max(1000).default(25),
    budgetCents: z.number().int().min(1).optional(),
    onAwaitingHuman: z.enum(['pause', 'fail', 'cancel']).default('pause'),
    instructions: z.string().max(16000).optional(),
    /** Client must echo the server's current worst-case estimate. */
    confirmCostCents: z.number().int(),
  });

  app.post('/api/runs', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const user = request.user;

    const estimate = runEstimateCents({ cuaVersion: body.cuaVersion, maxSteps: body.maxSteps });
    const budget = Math.min(body.budgetCents ?? user.budget_cents, user.budget_cents);
    if (estimate.maxCents > budget) {
      const fittingSteps = Math.floor(budget / estimate.perStepCents);
      throw new AppError(
        422,
        'BUDGET_EXCEEDED',
        `Worst-case cost ${estimate.maxCents}¢ exceeds the budget cap ${budget}¢`,
        { budgetCents: budget, maxCents: estimate.maxCents, suggestedMaxSteps: Math.max(fittingSteps, 1) },
      );
    }
    if (body.confirmCostCents !== estimate.maxCents) {
      throw new AppError(
        409,
        'ESTIMATE_CHANGED',
        'The cost estimate changed; re-confirm with the current value',
        { expectedCents: estimate.maxCents },
      );
    }
    // Wallet pre-flight (Coasty enforces too; failing early gives a better UX).
    const usage = await coasty.usage();
    const balance = usage.wallet_balance_cents ?? usage.balance;
    if (balance < estimate.perStepCents) {
      throw new AppError(402, 'INSUFFICIENT_CREDITS', 'Coasty wallet cannot cover a single step', {
        balanceCents: balance,
        requiredCents: estimate.perStepCents,
      });
    }

    const run = await coasty.createRun(
      {
        machine_id: body.machineId,
        task: body.task,
        cua_version: body.cuaVersion,
        max_steps: body.maxSteps,
        on_awaiting_human: body.onAwaitingHuman,
        instructions: body.instructions ?? null,
        webhook_url: `${config.publicUrl}/webhooks/coasty`,
        metadata: { cowork_user: user.id },
      },
      { idempotencyKey: `cwk-run-${randomUUID()}` },
    );

    const row: RunRow = {
      id: `r_${randomUUID().slice(0, 12)}`,
      user_id: user.id,
      kind: 'coasty',
      coasty_run_id: run.id,
      machine_id: run.machine_id,
      task: run.task,
      status: run.status,
      cua_version: run.cua_version,
      max_steps: run.max_steps,
      budget_cents: budget,
      cost_cents: run.cost_cents,
      steps_completed: run.steps_completed,
      result_json: null,
      error_json: null,
      awaiting_human_reason: null,
      webhook_secret: run.webhook_secret ?? null,
      created_at: new Date().toISOString(),
      finished_at: null,
    };
    db.insertRun(row);
    ingestor.start({ kind: 'run', localId: row.id, coastyId: run.id, userId: user.id });
    publishNotification(user.id, 'run.created', { runId: row.id, task: row.task });

    void reply.status(201);
    return runToDto(row);
  });

  // ── list + get ──────────────────────────────────────────────────────────────
  const listSchema = z.object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  app.get('/api/runs', async (request) => {
    const query = listSchema.parse(request.query);
    return { runs: db.listRuns(request.user.id, query).map(runToDto) };
  });

  app.get('/api/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    let row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    // Reconcile non-terminal cloud runs with upstream (covers missed events).
    if (row.kind === 'coasty' && row.coasty_run_id && !TERMINAL.has(row.status)) {
      try {
        const run = await coasty.getRun(row.coasty_run_id);
        row = syncRowFromCoasty(row, run);
        row = db.getRun(request.user.id, id) ?? row;
      } catch {
        // upstream hiccup: serve our last known state rather than failing the read
      }
    }
    return runToDto(row);
  });

  // ── cancel / resume ─────────────────────────────────────────────────────────
  app.post('/api/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    if (row.kind === 'local') {
      // Local runs are cancelled by the desktop app; mark intent here.
      db.updateRun(row.id, { status: 'cancelled', finished_at: new Date().toISOString() });
      const seq = db.appendEvent('run', row.id, 'status', { status: 'cancelled' });
      bus.publish({
        streamKind: 'run',
        streamId: row.id,
        seq,
        type: 'status',
        data: { status: 'cancelled' },
        userId: request.user.id,
        createdAt: new Date().toISOString(),
      });
      return runToDto(db.getRun(request.user.id, id)!);
    }
    const run = await coasty.cancelRun(row.coasty_run_id!);
    syncRowFromCoasty(row, run);
    return runToDto(db.getRun(request.user.id, id)!);
  });

  const resumeSchema = z.object({ note: z.string().max(2000).optional() });
  app.post('/api/runs/:id/resume', async (request) => {
    const { id } = request.params as { id: string };
    const body = resumeSchema.parse(request.body ?? {});
    const row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    if (row.kind === 'local') {
      throw new AppError(409, 'NOT_SUPPORTED', 'Local runs are resumed from the desktop app');
    }
    const run = await coasty.resumeRun(row.coasty_run_id!, { note: body.note });
    syncRowFromCoasty(row, run);
    return runToDto(db.getRun(request.user.id, id)!);
  });

  // ── event timeline (SSE; works for cloud AND local runs) ───────────────────
  app.get('/api/runs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    streamSse(request, reply, { db, bus, streamKind: 'run', streamId: id, closeOnType: 'done' });
  });

  // ── local runs (desktop LocalExecutor mirror) ───────────────────────────────
  const localCreateSchema = z.object({
    task: z.string().min(1).max(16000),
    maxSteps: z.number().int().min(1).max(1000).default(25),
    machineLabel: z.string().max(128).default('local'),
  });
  app.post('/api/local-runs', async (request, reply) => {
    const body = localCreateSchema.parse(request.body);
    const row: RunRow = {
      id: `r_${randomUUID().slice(0, 12)}`,
      user_id: request.user.id,
      kind: 'local',
      coasty_run_id: null,
      machine_id: body.machineLabel,
      task: body.task,
      status: 'running',
      cua_version: 'v3',
      max_steps: body.maxSteps,
      budget_cents: request.user.budget_cents,
      cost_cents: 0,
      steps_completed: 0,
      result_json: null,
      error_json: null,
      awaiting_human_reason: null,
      webhook_secret: null,
      created_at: new Date().toISOString(),
      finished_at: null,
    };
    db.insertRun(row);
    publishNotification(request.user.id, 'run.created', { runId: row.id, task: row.task, local: true });
    void reply.status(201);
    return runToDto(row);
  });

  const localEventsSchema = z.object({
    events: z
      .array(
        z.object({
          type: z.string().min(1).max(64),
          data: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1)
      .max(100),
  });
  app.post('/api/local-runs/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row || row.kind !== 'local') throw notFound('Local run');
    const { events } = localEventsSchema.parse(request.body);

    for (const evt of events) {
      const seq = db.appendEvent('run', id, evt.type, evt.data);
      applyLocalEvent(db, row.id, evt.type, evt.data);
      bus.publish({
        streamKind: 'run',
        streamId: id,
        seq,
        type: evt.type,
        data: evt.data,
        userId: request.user.id,
        createdAt: new Date().toISOString(),
      });
      if (evt.type === 'awaiting_human') {
        publishNotification(request.user.id, 'run.awaiting_human', {
          runId: id,
          reason: evt.data.reason ?? null,
          local: true,
        });
      }
      if (evt.type === 'done') {
        const status = typeof evt.data.status === 'string' ? evt.data.status : 'succeeded';
        publishNotification(request.user.id, `run.${status}`, { runId: id, local: true });
      }
    }
    return { appended: events.length };
  });

  const localPatchSchema = z.object({
    status: z.enum(['running', 'awaiting_human', 'succeeded', 'failed', 'cancelled', 'timed_out']),
    reason: z.string().max(2000).optional(),
    costCents: z.number().int().min(0).optional(),
  });
  app.patch('/api/local-runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row || row.kind !== 'local') throw notFound('Local run');
    const body = localPatchSchema.parse(request.body);
    db.updateRun(id, {
      status: body.status,
      ...(body.costCents !== undefined ? { cost_cents: body.costCents } : {}),
      ...(body.reason !== undefined ? { awaiting_human_reason: body.reason } : {}),
      ...(isTerminalRunStatus(body.status as RunStatus) ? { finished_at: new Date().toISOString() } : {}),
    });
    return runToDto(db.getRun(request.user.id, id)!);
  });
}

function applyLocalEvent(db: Db, runId: string, type: string, data: Record<string, unknown>): void {
  switch (type) {
    case 'status': {
      const status = typeof data.status === 'string' ? data.status : undefined;
      if (status) {
        db.updateRun(runId, {
          status,
          ...(['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)
            ? { finished_at: new Date().toISOString() }
            : {}),
        });
      }
      break;
    }
    case 'step':
      if (typeof data.steps_completed === 'number') {
        db.updateRun(runId, { steps_completed: data.steps_completed });
      }
      break;
    case 'billing':
      if (typeof data.cost_cents === 'number') {
        db.updateRun(runId, { cost_cents: data.cost_cents });
      }
      break;
    case 'awaiting_human':
      db.updateRun(runId, {
        status: 'awaiting_human',
        awaiting_human_reason: typeof data.reason === 'string' ? data.reason : 'Human takeover requested',
      });
      break;
    case 'done': {
      const status = typeof data.status === 'string' ? data.status : 'succeeded';
      db.updateRun(runId, {
        status,
        finished_at: new Date().toISOString(),
        ...(data.result !== undefined ? { result_json: JSON.stringify(data.result) } : {}),
      });
      break;
    }
    default:
      break;
  }
}
