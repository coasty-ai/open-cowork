/**
 * Task runs: server-side autonomous loop simulation with the documented state
 * machine, per-step billing, durable SSE events, webhooks, model-input frame
 * capture, and task-string behavior triggers (NEEDS_HUMAN / MUST_FAIL /
 * RUN_LONG) for tests. The stepper itself lives in `runEngine.ts` and is shared
 * with `POST /v1/tasks`.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx';
import { bodyHash, hex, nowIso, requestId, sendError } from './util';
import type { RunRec } from './state';
import { streamEvents } from './sseRoute';
import { finishRun, publicRun, RUN_STATUSES, startStepper, stepCents, TERMINAL } from './runEngine';
import { validateActionPolicyBody } from './actionPolicy';

export { publicRun } from './runEngine';

const ALLOWED_CREATE_FIELDS = new Set([
  'machine_id',
  'task',
  'cua_version',
  'instructions',
  'system_prompt',
  'max_steps',
  'deadline_seconds',
  'action_policy',
  'on_awaiting_human',
  'awaiting_human_timeout_seconds',
  'webhook_url',
  'metadata',
]);

/** All four engines are available on every tier; `v5` is the current default. */
export const CUA_VERSIONS = ['v1', 'v3', 'v4', 'v5'];
export const DEFAULT_CUA_VERSION = 'v5';

export function registerRunRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { state, opts } = ctx;

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
    const cua = (body.cua_version as string) ?? DEFAULT_CUA_VERSION;
    if (!CUA_VERSIONS.includes(cua)) {
      return sendError(
        reply,
        422,
        'VALIDATION_ERROR',
        `cua_version must be one of ${CUA_VERSIONS.join(', ')}`,
      );
    }
    const policyError = validateActionPolicyBody(body.action_policy);
    if (policyError) {
      return sendError(reply, 422, 'VALIDATION_ERROR', policyError.message, policyError.extras);
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
      mode: 'run',
      machine: null,
      action_policy: (body.action_policy as Record<string, unknown> | null) ?? null,
      deadlineAt:
        typeof body.deadline_seconds === 'number'
          ? opts.now() + body.deadline_seconds * 1000
          : null,
      stepsTarget: task.includes('RUN_LONG') ? 20 : opts.defaultRunSteps,
      attempt: 1,
      screenshots: [],
      provisionTicks: 0,
      cleanupTicks: 0,
      taskMachineOs: 'linux',
      taskMachineProvider: 'aws',
    };
    state.runs.set(run.id, run);
    startStepper(ctx, run, request.keyKind === 'test');

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

  // Static-ish sub-resources are declared before the bare `:id` handlers so the
  // documented route-order nuance is reproduced faithfully.
  app.get('/v1/runs/:id/screenshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.runs.get(id);
    if (!run)
      return sendError(reply, 404, 'RUN_NOT_FOUND', `No run '${id}' in this key's namespace`);
    const query = request.query as {
      after_index?: string;
      limit?: string;
      include_image?: string;
    };

    const includeImage = query.include_image === 'true' || query.include_image === '1';
    const afterIndexRaw = query.after_index;
    let afterIndex = -1;
    if (afterIndexRaw !== undefined) {
      const parsed = Number(afterIndexRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return sendError(
          reply,
          422,
          'VALIDATION_ERROR',
          'after_index must be a non-negative integer',
        );
      }
      afterIndex = parsed;
    }

    // Inlining images clamps the page hard: a frame is several hundred KB.
    const maxLimit = includeImage ? 10 : 200;
    let limit = includeImage ? 10 : 50;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        return sendError(reply, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200', {
          actual: parsed,
          min: 1,
          max: 200,
        });
      }
      limit = Math.min(parsed, maxLimit);
    }

    const all = run.screenshots.filter((f) => f.index > afterIndex);
    const page = all.slice(0, limit);
    if (includeImage) void reply.header('Cache-Control', 'no-store');

    return {
      object: 'list',
      data: page.map((f) => {
        const base = {
          index: f.index,
          attempt: f.attempt,
          step: f.step,
          taken_at: f.taken_at,
          width: f.width,
          height: f.height,
          mime_type: f.mime_type,
          size_bytes: f.size_bytes,
          sha256: f.sha256,
          degraded: f.degraded,
          encrypted_at_rest: f.encrypted_at_rest,
        };
        if (!includeImage) return base;
        // A frame that cannot be decoded is flagged, never returned as
        // ciphertext dressed up as an image, and never fails the page.
        return f.image_b64 === null
          ? { ...base, image_unavailable: true }
          : { ...base, image_b64: f.image_b64 };
      }),
      has_more: all.length > page.length,
      request_id: requestId(),
    };
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
    finishRun(ctx, run, 'cancelled');
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
