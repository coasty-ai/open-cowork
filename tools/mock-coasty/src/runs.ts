/**
 * Task runs: server-side autonomous loop simulation with the documented state
 * machine, per-step billing, durable SSE events, webhooks, and task-string
 * behavior triggers (NEEDS_HUMAN / MUST_FAIL / RUN_LONG) for tests.
 */
import type { FastifyInstance } from 'fastify';
import { debitBackground, type Ctx } from './ctx';
import { bodyHash, hex, nowIso, requestId, sendError } from './util';
import type { RunRec } from './state';
import { streamEvents } from './sseRoute';

const ALLOWED_CREATE_FIELDS = new Set([
  'machine_id',
  'task',
  'cua_version',
  'instructions',
  'system_prompt',
  'max_steps',
  'deadline_seconds',
  'on_awaiting_human',
  'awaiting_human_timeout_seconds',
  'webhook_url',
  'metadata',
]);

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

export function publicRun(run: RunRec, includeSecret: boolean): Record<string, unknown> {
  return {
    id: run.id,
    object: run.object,
    status: run.status,
    machine_id: run.machine_id,
    task: run.task,
    cua_version: run.cua_version,
    instructions: run.instructions,
    max_steps: run.max_steps,
    on_awaiting_human: run.on_awaiting_human,
    steps_completed: run.steps_completed,
    credits_charged: run.credits_charged,
    cost_cents: run.cost_cents,
    result: run.result,
    error: run.error,
    awaiting_human_reason: run.awaiting_human_reason,
    metadata: run.metadata,
    webhook_url: run.webhook_url,
    webhook_secret: includeSecret ? run.webhook_secret : null,
    created_at: run.created_at,
    started_at: run.started_at,
    awaiting_human_since: run.awaiting_human_since,
    finished_at: run.finished_at,
    request_id: run.request_id,
  };
}

export function registerRunRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { state, opts } = ctx;

  const stepCents = (cua: string): number => (cua === 'v1' ? 8 : 5);

  function finishRun(run: RunRec, status: string, extra: Partial<RunRec> = {}): void {
    run.status = status;
    run.finished_at = nowIso();
    Object.assign(run, extra);
    state.emit(run.id, 'status', { status });
    state.emit(run.id, 'done', { status, result: run.result, error: run.error });
    if (run.webhook_url && run.webhook_secret) {
      void state.deliverWebhook(run.webhook_url, run.webhook_secret, `run.${status}`, {
        run: publicRun(run, false),
      });
    }
  }

  /** One stepper tick. Drives the documented state machine. */
  function tick(run: RunRec, isTest: boolean): void {
    if (state.closed || TERMINAL.has(run.status)) return;
    if (run.deadlineAt !== null && Date.now() > run.deadlineAt && !TERMINAL.has(run.status)) {
      run.result = { passed: false, status: 'timed_out', summary: 'Deadline exceeded' };
      finishRun(run, 'timed_out');
      return;
    }
    if (run.status === 'awaiting_human') return; // paused: nothing to do

    if (run.status === 'queued') {
      run.status = 'running';
      run.started_at = nowIso();
      state.emit(run.id, 'status', { status: 'running' });
      return;
    }

    // One agent step.
    const step = run.steps_completed + 1;

    // Behavior trigger: pause for a human after 2 steps.
    if (run.task.includes('NEEDS_HUMAN') && step === 3 && run.awaiting_human_since === null) {
      const reason = 'The agent needs a human to complete a sensitive step.';
      if (run.on_awaiting_human === 'fail') {
        run.error = { code: 'AWAITING_HUMAN', message: reason };
        run.result = { passed: false, status: 'failed', summary: reason };
        finishRun(run, 'failed');
        return;
      }
      if (run.on_awaiting_human === 'cancel') {
        finishRun(run, 'cancelled');
        return;
      }
      run.status = 'awaiting_human';
      run.awaiting_human_reason = reason;
      run.awaiting_human_since = nowIso();
      state.emit(run.id, 'awaiting_human', { reason });
      state.emit(run.id, 'status', { status: 'awaiting_human' });
      if (run.webhook_url && run.webhook_secret) {
        void state.deliverWebhook(run.webhook_url, run.webhook_secret, 'run.awaiting_human', {
          run: publicRun(run, false),
        });
      }
      return;
    }

    // Bill the step (idempotently per step; resume bookkeeping is not billed).
    const cents = stepCents(run.cua_version);
    if (!debitBackground(ctx, isTest, 'runs', cents)) {
      run.error = { code: 'WALLET_EXHAUSTED', message: `Wallet ran dry at step ${step}` };
      run.result = { passed: false, status: 'failed', summary: 'Wallet exhausted mid-run' };
      finishRun(run, 'failed');
      return;
    }
    run.steps_completed = step;
    if (!isTest) {
      run.credits_charged += cents;
      run.cost_cents += cents;
    }

    state.emit(run.id, 'text', { text: `Working on it (step ${step})…` });
    state.emit(run.id, 'tool_call', { tool: 'click', params: { x: 512, y: 340 } });
    state.emit(run.id, 'tool_result', { success: true });
    state.emit(run.id, 'step', { steps_completed: step });
    state.emit(run.id, 'billing', {
      credits_charged: run.credits_charged,
      cost_cents: run.cost_cents,
    });

    if (run.task.includes('MUST_FAIL') && step >= 2) {
      run.result = {
        passed: false,
        status: 'failed',
        summary: 'The verifier rejected the outcome.',
      };
      run.error = { code: 'VERIFICATION_FAILED', message: 'Task verification failed' };
      finishRun(run, 'failed');
      return;
    }
    if (step >= run.stepsTarget) {
      run.result = { passed: true, status: 'succeeded', summary: `Task completed: ${run.task}` };
      finishRun(run, 'succeeded');
      return;
    }
    if (step >= run.max_steps) {
      run.result = {
        passed: false,
        status: 'failed',
        summary: 'Hit max_steps before completing the task.',
      };
      finishRun(run, 'failed');
    }
  }

  // ── create ──────────────────────────────────────────────────────────────────
  app.post('/v1/runs', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!ALLOWED_CREATE_FIELDS.has(key)) {
        return sendError(reply, 422, 'VALIDATION_ERROR', `Unknown field '${key}'`, {
          details: [{ loc: ['body', key], type: 'unknown_field' }],
        });
      }
    }
    const machineId = body.machine_id;
    const task = body.task;
    if (typeof machineId !== 'string' || machineId.length === 0 || machineId.length > 128) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'machine_id is required (1-128 chars)');
    }
    if (typeof task !== 'string' || task.length === 0 || task.length > 16000) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'task is required (1-16000 chars)');
    }
    if (!state.machines.has(machineId)) {
      return sendError(
        reply,
        404,
        'MACHINE_NOT_FOUND',
        `No machine '${machineId}' in this key's namespace`,
      );
    }
    const cua = (body.cua_version as string) ?? 'v3';
    if (!['v1', 'v3', 'v4'].includes(cua)) {
      return sendError(reply, 422, 'VALIDATION_ERROR', `cua_version must be one of v1, v3, v4`);
    }

    // Idempotency via the documented header.
    const idemKeyHeader = request.headers['idempotency-key'];
    const idemKey = Array.isArray(idemKeyHeader) ? idemKeyHeader[0] : idemKeyHeader;
    const hash = bodyHash(body);
    if (idemKey) {
      const existing = state.idempotency.get(`runs:${idemKey}`);
      if (existing) {
        if (existing.bodyHash !== hash) {
          return sendError(
            reply,
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was reused with a different body',
          );
        }
        void reply.header('X-Coasty-Idempotent-Replay', 'true');
        return reply.status(existing.status).send(existing.payload);
      }
    }

    // Wallet must cover at least one step.
    const oneStep = stepCents(cua);
    if (request.keyKind !== 'test' && state.walletCents < oneStep) {
      return sendError(
        reply,
        402,
        'INSUFFICIENT_CREDITS',
        `Starting a run needs ${oneStep} credits; you have ${state.walletCents}.`,
        {
          required: oneStep,
          balance: state.walletCents,
        },
      );
    }

    const webhookUrl = typeof body.webhook_url === 'string' ? body.webhook_url : null;
    const run: RunRec = {
      id: `run_${hex(5)}`,
      object: 'agent.run',
      status: 'queued',
      machine_id: machineId,
      task,
      cua_version: cua,
      instructions: (body.instructions as string | null) ?? null,
      max_steps: (body.max_steps as number) ?? 50,
      on_awaiting_human: (body.on_awaiting_human as RunRec['on_awaiting_human']) ?? 'pause',
      steps_completed: 0,
      credits_charged: 0,
      cost_cents: 0,
      result: null,
      error: null,
      awaiting_human_reason: null,
      metadata: (body.metadata as Record<string, unknown> | null) ?? null,
      webhook_url: webhookUrl,
      webhook_secret: webhookUrl ? `whsec_${hex(12)}` : null,
      created_at: nowIso(),
      started_at: null,
      awaiting_human_since: null,
      finished_at: null,
      request_id: requestId(),
      deadlineAt:
        typeof body.deadline_seconds === 'number'
          ? Date.now() + body.deadline_seconds * 1000
          : null,
      stepsTarget: task.includes('RUN_LONG') ? 20 : opts.defaultRunSteps,
    };
    state.runs.set(run.id, run);

    const isTest = request.keyKind === 'test';
    const timer = state.addTimer(setInterval(() => tick(run, isTest), opts.tickMs));
    // Stop the interval once terminal (checked inside tick via TERMINAL set);
    // also guard here so finished runs don't keep timers alive.
    const stopWatch = state.addTimer(
      setInterval(() => {
        if (TERMINAL.has(run.status) || state.closed) {
          clearInterval(timer);
          clearInterval(stopWatch);
          state.timers.delete(timer);
          state.timers.delete(stopWatch);
        }
      }, opts.tickMs * 4),
    );

    const payload = publicRun(run, true);
    if (idemKey) state.idempotency.set(`runs:${idemKey}`, { bodyHash: hash, status: 201, payload });
    return reply.status(201).send(payload);
  });

  // ── list + get ──────────────────────────────────────────────────────────────
  app.get('/v1/runs', async (request, reply) => {
    const query = request.query as { status?: string; limit?: string };
    const limit = query.limit !== undefined ? Number(query.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return sendError(reply, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200', {
        actual: limit,
        min: 1,
        max: 200,
      });
    }
    if (query.status !== undefined && !RUN_STATUSES.includes(query.status)) {
      return sendError(
        reply,
        400,
        'INVALID_STATUS_FILTER',
        `'${query.status}' is not a run status`,
        {
          valid_options: RUN_STATUSES,
        },
      );
    }
    const data = [...state.runs.values()]
      .filter((r) => (query.status ? r.status === query.status : true))
      .slice(0, limit)
      .map((r) => publicRun(r, false));
    return { object: 'list', data, has_more: false, request_id: requestId() };
  });

  app.get('/v1/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.runs.get(id);
    if (!run)
      return sendError(reply, 404, 'RUN_NOT_FOUND', `No run '${id}' in this key's namespace`);
    return publicRun(run, false);
  });

  // ── cancel / resume ─────────────────────────────────────────────────────────
  app.post('/v1/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.runs.get(id);
    if (!run)
      return sendError(reply, 404, 'RUN_NOT_FOUND', `No run '${id}' in this key's namespace`);
    if (TERMINAL.has(run.status)) {
      return sendError(
        reply,
        409,
        'INVALID_STATE',
        `Cannot cancel a run in state '${run.status}'`,
        {
          current_state: run.status,
          allowed_from: ['queued', 'running', 'awaiting_human'],
        },
      );
    }
    finishRun(run, 'cancelled');
    return publicRun(run, false);
  });

  app.post('/v1/runs/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.runs.get(id);
    if (!run)
      return sendError(reply, 404, 'RUN_NOT_FOUND', `No run '${id}' in this key's namespace`);
    if (run.status !== 'awaiting_human') {
      return sendError(
        reply,
        409,
        'NOT_AWAITING_HUMAN',
        `Run is '${run.status}', not awaiting_human`,
      );
    }
    const body = (request.body ?? {}) as { note?: string };
    run.status = 'running';
    run.awaiting_human_reason = null;
    state.emit(run.id, 'resumed', { note: body.note ?? null });
    state.emit(run.id, 'status', { status: 'running' });
    return publicRun(run, false);
  });

  // ── events (SSE) ────────────────────────────────────────────────────────────
  app.get('/v1/runs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.runs.get(id);
    if (!run) {
      void sendError(reply, 404, 'RUN_NOT_FOUND', `No run '${id}' in this key's namespace`);
      return;
    }
    streamEvents(state, id, request, reply);
  });
}
