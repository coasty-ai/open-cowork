/**
 * `POST /v1/tasks` — submit-and-forget. One goal in; the caller never
 * provisions, selects, monitors, or destroys a machine, and the agent never
 * pauses for a human.
 *
 * The returned resource is an ordinary durable `agent.run`, so every run route
 * (get / events / cancel / screenshots) already works on it. What is task-
 * specific lives in three places: admission validation here, the provisioning
 * prologue + cleanup epilogue in `runEngine.ts`, and the `machine` lifecycle
 * view on the run object.
 *
 * DELIBERATE DEVIATION: the real API requires an HTTPS `webhook_url` and
 * rejects loopback/private targets. The mock accepts http loopback, because the
 * whole point of demo mode is a local backend receiving its own webhooks at
 * `http://127.0.0.1:4000/webhooks/coasty`. Everything else about the URL
 * contract (userinfo rejection, parseability, scheme allowlist) is enforced.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx';
import { bodyHash, hex, nowIso, requestId, sendError } from './util';
import type { RunRec, RunMachineViewRec } from './state';
import { publicRun, startStepper, stepCents } from './runEngine';
import { validateActionPolicyBody } from './actionPolicy';
import { CUA_VERSIONS, DEFAULT_CUA_VERSION } from './runs';

const ALLOWED_TASK_FIELDS = new Set([
  'task',
  'cua_version',
  'instructions',
  'system_prompt',
  'max_steps',
  'deadline_seconds',
  'action_policy',
  'webhook_url',
  'metadata',
  'llm',
  'machine',
]);

const ALLOWED_MACHINE_FIELDS = new Set([
  'provider',
  'os_type',
  'desktop_enabled',
  'cpu_cores',
  'memory_gb',
  'storage_gb',
  'restore_from_snapshot',
  'proxy',
]);

const TASK_MACHINE_PROVIDERS = ['auto', 'aws', 'daytona', 'azure'];

/** Upstream default for tasks (ordinary runs default to 50). */
const DEFAULT_TASK_MAX_STEPS = 150;
/** Wallet minimum to provision, a gate rather than a fee. */
const PROVISIONING_GATE_CENTS = 20;

interface RangeSpec {
  field: string;
  min: number;
  max: number;
}

const MACHINE_RANGES: RangeSpec[] = [
  { field: 'cpu_cores', min: 1, max: 16 },
  { field: 'memory_gb', min: 1, max: 64 },
  { field: 'storage_gb', min: 8, max: 500 },
];

function validationError(
  reply: Parameters<typeof sendError>[0],
  message: string,
  loc: string[],
): ReturnType<typeof sendError> {
  return sendError(reply, 422, 'VALIDATION_ERROR', message, {
    details: [{ loc: ['body', ...loc], type: 'value_error' }],
  });
}

export function registerTaskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { state, opts } = ctx;

  app.post('/v1/tasks', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    for (const key of Object.keys(body)) {
      if (!ALLOWED_TASK_FIELDS.has(key)) {
        return sendError(reply, 422, 'VALIDATION_ERROR', `Unknown field '${key}'`, {
          details: [{ loc: ['body', key], type: 'unknown_field' }],
        });
      }
    }

    // ── task ────────────────────────────────────────────────────────────────
    const task = body.task;
    if (typeof task !== 'string' || task.length === 0 || task.length > 16000) {
      return validationError(reply, 'task is required (1-16000 chars)', ['task']);
    }

    // ── engine ──────────────────────────────────────────────────────────────
    const cua = (body.cua_version as string) ?? DEFAULT_CUA_VERSION;
    if (!CUA_VERSIONS.includes(cua)) {
      return validationError(reply, `cua_version must be one of ${CUA_VERSIONS.join(', ')}`, [
        'cua_version',
      ]);
    }

    // ── budgets ─────────────────────────────────────────────────────────────
    const maxSteps = body.max_steps ?? DEFAULT_TASK_MAX_STEPS;
    if (
      typeof maxSteps !== 'number' ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 1000
    ) {
      return validationError(reply, 'max_steps must be an integer between 1 and 1000', [
        'max_steps',
      ]);
    }
    const deadlineSeconds = body.deadline_seconds ?? null;
    if (deadlineSeconds !== null) {
      if (
        typeof deadlineSeconds !== 'number' ||
        !Number.isInteger(deadlineSeconds) ||
        deadlineSeconds < 1 ||
        deadlineSeconds > 86400
      ) {
        return validationError(reply, 'deadline_seconds must be an integer between 1 and 86400', [
          'deadline_seconds',
        ]);
      }
    }

    // ── prompt steering ─────────────────────────────────────────────────────
    if (body.instructions !== undefined && body.instructions !== null) {
      if (typeof body.instructions !== 'string' || body.instructions.length > 16000) {
        return validationError(reply, 'instructions must be a string of at most 16000 chars', [
          'instructions',
        ]);
      }
    }
    if (body.system_prompt !== undefined && body.system_prompt !== null) {
      if (typeof body.system_prompt !== 'string' || body.system_prompt.length > 32000) {
        return validationError(reply, 'system_prompt must be a string of at most 32000 chars', [
          'system_prompt',
        ]);
      }
    }

    // ── action policy ───────────────────────────────────────────────────────
    const policyError = validateActionPolicyBody(body.action_policy);
    if (policyError) {
      return sendError(reply, 422, 'VALIDATION_ERROR', policyError.message, policyError.extras);
    }

    // ── webhook url ─────────────────────────────────────────────────────────
    const webhookUrl = body.webhook_url ?? null;
    if (webhookUrl !== null) {
      if (typeof webhookUrl !== 'string') {
        return validationError(reply, 'webhook_url must be a string', ['webhook_url']);
      }
      let parsed: URL;
      try {
        parsed = new URL(webhookUrl);
      } catch {
        return validationError(reply, 'webhook_url must be an absolute URL', ['webhook_url']);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return validationError(reply, 'webhook_url must use https', ['webhook_url']);
      }
      if (parsed.username !== '' || parsed.password !== '') {
        return validationError(reply, 'webhook_url must not contain userinfo', ['webhook_url']);
      }
    }

    // ── metadata ────────────────────────────────────────────────────────────
    if (body.metadata !== undefined && body.metadata !== null) {
      const meta = body.metadata;
      if (typeof meta !== 'object' || Array.isArray(meta)) {
        return validationError(reply, 'metadata must be an object', ['metadata']);
      }
      if (Object.keys(meta as object).length > 50) {
        return validationError(reply, 'metadata accepts at most 50 keys', ['metadata']);
      }
    }

    // ── BYOK ────────────────────────────────────────────────────────────────
    // A test key may not carry BYOK intent into an ASYNC surface. This fails
    // closed BEFORE execution rather than silently ignoring a provider secret.
    const llm = body.llm as { provider?: unknown; model?: unknown } | null | undefined;
    const headerLlmKey = request.headers['x-llm-api-key'];
    const hasByokIntent =
      (llm != null && typeof llm.provider === 'string' && llm.provider !== 'managed') ||
      headerLlmKey !== undefined;
    if (llm != null) {
      if (typeof llm !== 'object' || Array.isArray(llm)) {
        return validationError(reply, 'llm must be an object', ['llm']);
      }
      if (
        llm.provider !== undefined &&
        !['managed', 'anthropic', 'openai'].includes(llm.provider as string)
      ) {
        return sendError(
          reply,
          422,
          'LLM_PROVIDER_UNSUPPORTED',
          `Unsupported llm.provider '${String(llm.provider)}'`,
        );
      }
      if (llm.model !== undefined && llm.model !== null) {
        const model = llm.model;
        if (typeof model !== 'string' || model.length === 0 || model.length > 256) {
          return sendError(reply, 422, 'LLM_MODEL_INVALID', 'llm.model is empty or too long');
        }
        // Credential-shaped model ids are rejected NON-REFLECTIVELY: the
        // supplied value never appears in the error.
        if (/^(sk-|bearer\s|authorization|api[_-]?key|secret)/i.test(model)) {
          return sendError(
            reply,
            422,
            'LLM_MODEL_INVALID',
            'llm.model looks like a credential; put provider keys only in X-LLM-Api-Key',
          );
        }
      }
    }
    if (hasByokIntent && request.keyKind === 'test') {
      return sendError(
        reply,
        422,
        'LLM_PROVIDER_UNSUPPORTED',
        'BYOK is unavailable for synthetic test runs, workflows, and schedules. Use managed mode or a live Coasty API key.',
      );
    }

    // ── machine preferences ─────────────────────────────────────────────────
    let osType: 'linux' | 'windows' = 'linux';
    let provider = 'auto';
    if (body.machine !== undefined && body.machine !== null) {
      const machine = body.machine;
      if (typeof machine !== 'object' || Array.isArray(machine)) {
        return validationError(reply, 'machine must be an object', ['machine']);
      }
      const m = machine as Record<string, unknown>;
      for (const key of Object.keys(m)) {
        if (!ALLOWED_MACHINE_FIELDS.has(key)) {
          return validationError(reply, `Unknown machine field '${key}'`, ['machine', key]);
        }
      }
      if (m.provider !== undefined) {
        if (typeof m.provider !== 'string' || !TASK_MACHINE_PROVIDERS.includes(m.provider)) {
          return validationError(
            reply,
            `machine.provider must be one of ${TASK_MACHINE_PROVIDERS.join(', ')}`,
            ['machine', 'provider'],
          );
        }
        provider = m.provider;
      }
      if (m.os_type !== undefined) {
        if (m.os_type !== 'linux' && m.os_type !== 'windows') {
          return validationError(reply, "machine.os_type must be 'linux' or 'windows'", [
            'machine',
            'os_type',
          ]);
        }
        osType = m.os_type;
      }
      if (m.desktop_enabled !== undefined && typeof m.desktop_enabled !== 'boolean') {
        return validationError(reply, 'machine.desktop_enabled must be a boolean', [
          'machine',
          'desktop_enabled',
        ]);
      }
      for (const spec of MACHINE_RANGES) {
        const value = m[spec.field];
        if (value === undefined || value === null) continue;
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < spec.min ||
          value > spec.max
        ) {
          return validationError(
            reply,
            `machine.${spec.field} must be an integer between ${spec.min} and ${spec.max}`,
            ['machine', spec.field],
          );
        }
      }
      if (m.proxy !== undefined && m.proxy !== null) {
        const proxy = m.proxy as Record<string, unknown>;
        if (typeof proxy !== 'object' || Array.isArray(proxy)) {
          return validationError(reply, 'machine.proxy must be an object', ['machine', 'proxy']);
        }
        if (proxy.mode !== 'managed' && proxy.mode !== 'custom') {
          return validationError(reply, "machine.proxy.mode must be 'managed' or 'custom'", [
            'machine',
            'proxy',
            'mode',
          ]);
        }
        if (proxy.mode === 'custom') {
          if (!['http', 'https', 'socks5'].includes(proxy.scheme as string)) {
            return validationError(reply, 'machine.proxy.scheme must be http, https, or socks5', [
              'machine',
              'proxy',
              'scheme',
            ]);
          }
          if (typeof proxy.host !== 'string' || proxy.host.length === 0) {
            return validationError(reply, 'machine.proxy.host is required', [
              'machine',
              'proxy',
              'host',
            ]);
          }
          const port = proxy.port;
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            return validationError(reply, 'machine.proxy.port must be a valid port', [
              'machine',
              'proxy',
              'port',
            ]);
          }
        }
      }
    }

    // ── idempotency ─────────────────────────────────────────────────────────
    // The whole body is hashed, so machine.provider is part of the identity: a
    // replay lands on the same backend rather than silently migrating.
    const idemHeader = request.headers['idempotency-key'];
    const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
    if (idemKey !== undefined) {
      if (idemKey.length > 128 || !/^[A-Za-z0-9_\-:]+$/.test(idemKey)) {
        return validationError(
          reply,
          'Idempotency-Key must be at most 128 chars of [A-Za-z0-9_-:]',
          ['Idempotency-Key'],
        );
      }
      const existing = state.idempotency.get(`tasks:${idemKey}`);
      if (existing) {
        if (existing.bodyHash !== bodyHash(body)) {
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

    // ── wallet gates ────────────────────────────────────────────────────────
    const isTest = request.keyKind === 'test';
    if (!isTest) {
      if (state.walletCents < PROVISIONING_GATE_CENTS) {
        return sendError(
          reply,
          402,
          'INSUFFICIENT_CREDITS',
          `Provisioning requires a wallet balance of at least ${PROVISIONING_GATE_CENTS} credits; you have ${state.walletCents}.`,
          { required: PROVISIONING_GATE_CENTS, balance: state.walletCents },
        );
      }
      const oneStep = stepCents(cua);
      if (state.walletCents < oneStep) {
        return sendError(
          reply,
          402,
          'INSUFFICIENT_CREDITS',
          `Starting a task needs ${oneStep} credits; you have ${state.walletCents}.`,
          { required: oneStep, balance: state.walletCents },
        );
      }
    }

    // ── admit ───────────────────────────────────────────────────────────────
    const machineView: RunMachineViewRec = {
      mode: 'automatic',
      status: 'provisioning',
      id: null,
      cleanup: 'always',
      cleanup_status: 'pending',
    };
    const run: RunRec = {
      id: `run_${hex(5)}`,
      object: 'agent.run',
      status: 'queued',
      // Intentionally null while provisioning.
      machine_id: null,
      task,
      cua_version: cua,
      instructions: (body.instructions as string | null) ?? null,
      max_steps: maxSteps,
      // Human takeover is HARDWIRED to fail at the public Run contract.
      on_awaiting_human: 'fail',
      steps_completed: 0,
      credits_charged: 0,
      cost_cents: 0,
      result: null,
      error: null,
      awaiting_human_reason: null,
      metadata: (body.metadata as Record<string, unknown> | null) ?? null,
      webhook_url: (webhookUrl as string | null) ?? null,
      webhook_secret: webhookUrl ? `whsec_${hex(12)}` : null,
      created_at: nowIso(),
      started_at: null,
      awaiting_human_since: null,
      finished_at: null,
      request_id: requestId(),
      mode: 'task',
      machine: machineView,
      action_policy: (body.action_policy as Record<string, unknown> | null) ?? null,
      deadlineAt: deadlineSeconds !== null ? opts.now() + (deadlineSeconds as number) * 1000 : null,
      stepsTarget: task.includes('RUN_LONG') ? 20 : opts.defaultRunSteps,
      attempt: 1,
      screenshots: [],
      provisionTicks: 0,
      cleanupTicks: 0,
      taskMachineOs: osType,
      taskMachineProvider: provider === 'auto' ? 'aws' : provider,
    };
    state.runs.set(run.id, run);
    startStepper(ctx, run, isTest);

    const payload = publicRun(run, true);
    if (idemKey !== undefined) {
      state.idempotency.set(`tasks:${idemKey}`, {
        bodyHash: bodyHash(body),
        status: 201,
        payload,
      });
    }
    return reply.status(201).send(payload);
  });
}
