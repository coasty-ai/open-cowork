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
  CUA_VERSIONS,
  DEFAULT_TASK_DEADLINE_SECONDS,
  DEFAULT_TASK_MAX_STEPS,
  isTerminalRunStatus,
  PRICING,
  runEstimateCents,
  taskEstimateCents,
  validateActionPolicy,
  type ActionPolicy,
  type CoastyClient,
  type Run,
  type RunMachineView,
  type RunStatus,
} from '@open-cowork/core';
import type { BackendConfig } from '../config';
import type { Db, RunKind, RunRow } from '../db';
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
  kind: RunKind;
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
  /** Automatic machine lifecycle; non-null only for `kind: 'task'`. */
  machine: RunMachineView | null;
  deadlineSeconds: number | null;
  /** The exact policy we submitted (Coasty never echoes the normalized form). */
  actionPolicy: unknown;
}

/**
 * Has a task's ephemeral machine reached a settled cleanup state?
 *
 * `terminated` and `failed` are final; `pending`/`terminating`/`retrying` can
 * all still change, so a run sitting in one of those is still worth
 * reconciling even though the RUN itself is already terminal. Non-task runs
 * have no cleanup lifecycle and are always considered settled.
 */
function cleanupSettled(row: RunRow): boolean {
  if (row.kind !== 'task') return true;
  const view = parseJson<RunMachineView>(row.machine_json ?? null);
  if (!view) return false;
  return view.cleanup_status === 'terminated' || view.cleanup_status === 'failed';
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt column must degrade to "absent", never break a list response.
    return null;
  }
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
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    awaitingHumanReason: row.awaiting_human_reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    machine: parseJson<RunMachineView>(row.machine_json ?? null),
    deadlineSeconds: row.deadline_seconds ?? null,
    actionPolicy: parseJson(row.action_policy_json ?? null),
  };
}

const TERMINAL = new Set<string>(['succeeded', 'failed', 'cancelled', 'timed_out']);

/**
 * `action_policy` is validated by core's validator rather than re-modelled in
 * zod: the documented rules are cross-field (blocked/allowed overlap, inclusive
 * coordinate rectangle), and duplicating them here would let the two drift.
 */
const actionPolicySchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .superRefine((value, ctx) => {
    const result = validateActionPolicy(value);
    for (const issue of result.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${issue.path}: ${issue.message}` });
    }
  });

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const { config, db, bus, coasty, ingestor } = deps;

  const publishNotification = (
    userId: string,
    type: string,
    data: Record<string, unknown>,
  ): void => {
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
    // A task run's machine_id starts null and is filled in once provisioning
    // completes, so it has to be picked up on reconcile — not just at create.
    const machineJson = run.machine ? JSON.stringify(run.machine) : row.machine_json;
    db.updateRun(row.id, {
      status: run.status,
      cost_cents: run.cost_cents,
      steps_completed: run.steps_completed,
      result_json: run.result ? JSON.stringify(run.result) : null,
      error_json: run.error ? JSON.stringify(run.error) : null,
      awaiting_human_reason: run.awaiting_human_reason,
      finished_at: run.finished_at,
      ...(run.machine_id ? { machine_id: run.machine_id } : {}),
      ...(machineJson !== row.machine_json ? { machine_json: machineJson } : {}),
    });
    return {
      ...row,
      status: run.status,
      cost_cents: run.cost_cents,
      steps_completed: run.steps_completed,
      machine_id: run.machine_id ?? row.machine_id,
      machine_json: machineJson,
    };
  };

  // ── create a cloud run ──────────────────────────────────────────────────────
  const createSchema = z.object({
    machineId: z.string().min(1).max(128),
    task: z.string().min(1).max(16000),
    // Explicit rather than relying on the upstream default: the upstream
    // default moved from v3 to v5, and a silent engine change under a
    // confirmed cost estimate is exactly what the handshake exists to prevent.
    cuaVersion: z.enum(CUA_VERSIONS).default('v3'),
    maxSteps: z.number().int().min(1).max(1000).default(25),
    budgetCents: z.number().int().min(1).optional(),
    onAwaitingHuman: z.enum(['pause', 'fail', 'cancel']).default('pause'),
    instructions: z.string().max(16000).optional(),
    actionPolicy: actionPolicySchema.optional(),
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
        {
          budgetCents: budget,
          maxCents: estimate.maxCents,
          suggestedMaxSteps: Math.max(fittingSteps, 1),
        },
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
    // Wallet pre-flight is BEST-EFFORT only. The `usage` scope is not granted
    // on a default Coasty key, so coasty.usage() may 403; it can also fail
    // transiently. Never let the preflight abort an otherwise-valid run —
    // Coasty enforces credits authoritatively at creation (402 INSUFFICIENT_
    // CREDITS), which we surface faithfully.
    try {
      const usage = await coasty.usage();
      const balance = usage.wallet_balance_cents ?? usage.balance;
      if (typeof balance === 'number' && balance < estimate.perStepCents) {
        throw new AppError(
          402,
          'INSUFFICIENT_CREDITS',
          'Coasty wallet cannot cover a single step',
          {
            balanceCents: balance,
            requiredCents: estimate.perStepCents,
          },
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err; // the 402 we just raised
      // usage() failed (e.g. missing `usage` scope) — skip the preflight.
    }

    const actionPolicy = (body.actionPolicy ?? null) as ActionPolicy | null;
    const run = await coasty.createRun(
      {
        machine_id: body.machineId,
        task: body.task,
        cua_version: body.cuaVersion,
        max_steps: body.maxSteps,
        on_awaiting_human: body.onAwaitingHuman,
        instructions: body.instructions ?? null,
        action_policy: actionPolicy,
        webhook_url: config.webhookUrl,
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
      machine_json: run.machine ? JSON.stringify(run.machine) : null,
      deadline_seconds: null,
      action_policy_json: actionPolicy ? JSON.stringify(actionPolicy) : null,
    };
    db.insertRun(row);
    ingestor.start({ kind: 'run', localId: row.id, coastyId: run.id, userId: user.id });
    publishNotification(user.id, 'run.created', { runId: row.id, task: row.task });

    void reply.status(201);
    return runToDto(row);
  });

  // ── create a submit-and-forget task ─────────────────────────────────────────
  // The caller supplies a goal and nothing else: Coasty provisions, drives, and
  // destroys an ephemeral machine. Two things make this different from a run:
  //
  //  1. TWO meters. A task bills agent steps AND machine runtime, so the
  //     handshake covers both — `runEstimateCents` would understate it badly.
  //  2. The deadline is mandatory HERE even though it is optional upstream.
  //     Machine runtime accrues for as long as the task runs, so an unbounded
  //     deadline means an unbounded bill and nothing honest to confirm. We
  //     always send an explicit one, defaulting to DEFAULT_TASK_DEADLINE_SECONDS.
  const taskSchema = z.object({
    task: z.string().min(1).max(16000),
    cuaVersion: z.enum(CUA_VERSIONS).default('v5'),
    maxSteps: z.number().int().min(1).max(1000).default(DEFAULT_TASK_MAX_STEPS),
    deadlineSeconds: z.number().int().min(1).max(86400).default(DEFAULT_TASK_DEADLINE_SECONDS),
    osType: z.enum(['linux', 'windows']).default('linux'),
    machineProvider: z.enum(['auto', 'aws', 'daytona', 'azure']).default('auto'),
    desktopEnabled: z.boolean().default(true),
    instructions: z.string().max(16000).optional(),
    actionPolicy: actionPolicySchema.optional(),
    budgetCents: z.number().int().min(1).optional(),
    confirmCostCents: z.number().int(),
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = taskSchema.parse(request.body);
    const user = request.user;

    const estimate = taskEstimateCents({
      cuaVersion: body.cuaVersion,
      maxSteps: body.maxSteps,
      deadlineSeconds: body.deadlineSeconds,
      osType: body.osType,
    });
    const budget = Math.min(body.budgetCents ?? user.budget_cents, user.budget_cents);
    if (estimate.maxCents > budget) {
      // Steps are the only lever the caller can turn down without changing the
      // wall-clock budget, so the suggestion is expressed in steps — and floored
      // at 1 only when the machine component alone already fits.
      const roomForSteps = budget - estimate.machineCents;
      throw new AppError(
        422,
        'BUDGET_EXCEEDED',
        `Worst-case cost ${estimate.maxCents}¢ exceeds the budget cap ${budget}¢`,
        {
          budgetCents: budget,
          maxCents: estimate.maxCents,
          stepsCents: estimate.stepsCents,
          machineCents: estimate.machineCents,
          suggestedMaxSteps:
            roomForSteps >= estimate.perStepCents
              ? Math.floor(roomForSteps / estimate.perStepCents)
              : null,
        },
      );
    }
    if (body.confirmCostCents !== estimate.maxCents) {
      throw new AppError(
        409,
        'ESTIMATE_CHANGED',
        'The cost estimate changed; re-confirm with the current value',
        {
          expectedCents: estimate.maxCents,
          stepsCents: estimate.stepsCents,
          machineCents: estimate.machineCents,
        },
      );
    }

    // Wallet pre-flight is BEST-EFFORT (the `usage` scope is not on a default
    // key). A task needs the $0.20 provisioning gate, not just one step —
    // Coasty enforces both authoritatively, we just surface them earlier.
    try {
      const usage = await coasty.usage();
      const balance = usage.wallet_balance_cents ?? usage.balance;
      if (typeof balance === 'number' && balance < PRICING.provisioningGateCents) {
        throw new AppError(
          402,
          'INSUFFICIENT_CREDITS',
          'A task provisions a machine, which requires a $0.20 wallet minimum',
          { balanceCents: balance, requiredCents: PRICING.provisioningGateCents },
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // usage() failed (e.g. missing `usage` scope) — skip the preflight.
    }

    const actionPolicy = (body.actionPolicy ?? null) as ActionPolicy | null;
    // The idempotency key is not optional here: upstream derives the internal
    // machine-provision key from the run id, so an unkeyed retry after a
    // network failure can leave a SECOND ephemeral machine running and billing.
    const run = await coasty.createTask(
      {
        task: body.task,
        cua_version: body.cuaVersion,
        max_steps: body.maxSteps,
        deadline_seconds: body.deadlineSeconds,
        instructions: body.instructions ?? null,
        action_policy: actionPolicy,
        webhook_url: config.webhookUrl,
        metadata: { cowork_user: user.id },
        machine: {
          provider: body.machineProvider,
          os_type: body.osType,
          desktop_enabled: body.desktopEnabled,
        },
      },
      { idempotencyKey: `cwk-task-${randomUUID()}` },
    );

    const row: RunRow = {
      id: `r_${randomUUID().slice(0, 12)}`,
      user_id: user.id,
      kind: 'task',
      coasty_run_id: run.id,
      // Intentionally null while provisioning; filled in by the reconcile path.
      machine_id: run.machine_id ?? null,
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
      machine_json: run.machine ? JSON.stringify(run.machine) : null,
      deadline_seconds: body.deadlineSeconds,
      action_policy_json: actionPolicy ? JSON.stringify(actionPolicy) : null,
    };
    db.insertRun(row);
    ingestor.start({ kind: 'run', localId: row.id, coastyId: run.id, userId: user.id });
    publishNotification(user.id, 'run.created', { runId: row.id, task: row.task, task_mode: true });

    void reply.status(201);
    return runToDto(row);
  });

  // ── model-input frames (what the agent actually saw) ────────────────────────
  // Registered BEFORE the dynamic ':id' routes below, mirroring the documented
  // upstream route-order nuance.
  const screenshotQuerySchema = z.object({
    afterIndex: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    includeImage: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  });
  app.get('/api/runs/:id/screenshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    if (!row.coasty_run_id) {
      // Local runs never reach Coasty, so there are no stored frames. Answer
      // with an empty page rather than a 404 so one client code path works for
      // every run kind.
      return { object: 'list', data: [], has_more: false };
    }
    const query = screenshotQuerySchema.parse(request.query ?? {});
    const res = await coasty.listRunScreenshots(row.coasty_run_id, {
      after_index: query.afterIndex,
      limit: query.limit,
      include_image: query.includeImage,
    });
    // A frame can show an inbox, a dashboard, or a billing page. When bytes are
    // inlined, forbid caching all the way down to the browser.
    if (query.includeImage) void reply.header('Cache-Control', 'no-store');
    return res;
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
    // Reconcile non-terminal upstream runs (covers missed events). Task runs
    // MUST be included: their machine_id and cleanup_status only ever arrive
    // this way or by webhook, never at create time.
    //
    // And a task keeps changing AFTER it goes terminal: cleanup begins once the
    // run finishes and can still be `terminating`/`retrying`. Stopping at the
    // terminal status would freeze the machine view at whatever it was the
    // instant the task ended, so the user would never learn the VM was actually
    // destroyed. Keep reconciling until cleanup settles.
    if (
      row.kind !== 'local' &&
      row.coasty_run_id &&
      (!TERMINAL.has(row.status) || !cleanupSettled(row))
    ) {
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
    if (row.kind === 'task') {
      // Submit-and-forget tasks never enter `awaiting_human`: the executor
      // intercepts handoff requests and carries on. There is nothing to resume,
      // and forwarding this would just earn a 409 NOT_AWAITING_HUMAN upstream.
      throw new AppError(
        409,
        'NOT_SUPPORTED',
        'Tasks run autonomously and never pause for a human, so they cannot be resumed',
      );
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

  // REST polling fallback for clients without streaming fetch (React Native).
  app.get('/api/runs/:id/events.json', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row) throw notFound('Run');
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;
    const events = db.eventsAfter('run', id, after).map((e) => ({
      seq: e.seq,
      type: e.type,
      data: JSON.parse(e.data_json) as Record<string, unknown>,
      createdAt: e.created_at,
    }));
    return { events, done: events.some((e) => e.type === 'done') };
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
      machine_json: null,
      deadline_seconds: null,
      action_policy_json: null,
    };
    db.insertRun(row);
    publishNotification(request.user.id, 'run.created', {
      runId: row.id,
      task: row.task,
      local: true,
    });
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

  // ── local-run live frames ───────────────────────────────────────────────────
  // The desktop captures the screen each step; we keep only the LATEST frame
  // per local run in memory (bounded), so every client's screen view shows the
  // live local screen without bloating the durable event log. Frames are
  // ephemeral by design — lost on restart, which is fine (the timeline is the
  // durable record).
  interface LocalFrame {
    base64: string;
    width: number;
    height: number;
    capturedAt: string;
  }
  const MAX_TRACKED_FRAMES = 50;
  const localFrames = new Map<string, LocalFrame>();
  const rememberFrame = (runId: string, frame: LocalFrame): void => {
    localFrames.delete(runId); // re-insert to keep Map insertion order = recency
    localFrames.set(runId, frame);
    while (localFrames.size > MAX_TRACKED_FRAMES) {
      const oldest = localFrames.keys().next().value;
      if (oldest === undefined) break;
      localFrames.delete(oldest);
    }
  };

  const frameSchema = z.object({
    base64: z.string().min(1).max(16_000_000),
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
  });
  app.post('/api/local-runs/:id/frame', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row || row.kind !== 'local') throw notFound('Local run');
    const body = frameSchema.parse(request.body);
    rememberFrame(id, { ...body, capturedAt: new Date().toISOString() });
    return { ok: true };
  });

  app.get('/api/local-runs/:id/frame', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getRun(request.user.id, id);
    if (!row || row.kind !== 'local') throw notFound('Local run');
    const frame = localFrames.get(id);
    return frame
      ? {
          base64: frame.base64,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
        }
      : { base64: null, width: null, height: null, capturedAt: null };
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
      ...(isTerminalRunStatus(body.status as RunStatus)
        ? { finished_at: new Date().toISOString() }
        : {}),
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
        awaiting_human_reason:
          typeof data.reason === 'string' ? data.reason : 'Human takeover requested',
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
