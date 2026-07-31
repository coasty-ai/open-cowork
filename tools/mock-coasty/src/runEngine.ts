/**
 * Shared stepper for both run flavours:
 *   - `mode: 'run'`  — POST /v1/runs, caller-supplied machine, may pause for a human.
 *   - `mode: 'task'` — POST /v1/tasks, Coasty-provisioned ephemeral machine,
 *                      NEVER pauses for a human, always cleans the machine up.
 *
 * Keeping one stepper means the task lifecycle cannot silently drift away from
 * the run lifecycle: a task IS a run with a provisioning prologue and a cleanup
 * epilogue, which is exactly how the API models it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { debitBackground, type Ctx } from './ctx';
import { generatePng, hex, nowIso } from './util';
import type { FrameRec, MachineRec, RunRec } from './state';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

/** Ticks spent "provisioning" before a task machine becomes ready. */
const PROVISION_TICKS = 2;
/** Ticks between the terminal transition and cleanup completing. */
const CLEANUP_TICKS = 2;

export function stepCents(cua: string): number {
  return cua === 'v1' ? 8 : 5;
}

export function publicRun(run: RunRec, includeSecret: boolean): Record<string, unknown> {
  return {
    id: run.id,
    object: run.object,
    status: run.status,
    machine_id: run.machine_id,
    // Only task runs carry the automatic lifecycle view; ordinary runs send null.
    machine: run.machine,
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

/** Capture the model-input frame the agent "saw" before a decision. */
function captureFrame(run: RunRec, step: number): void {
  // 1280x720 is deliberately NOT HD per the documented strict boundary, so the
  // mock's frames never imply an HD surcharge.
  const width = 1280;
  const height = 720;
  const degraded = run.task.includes('DEGRADED_FRAME') && step === 2;
  const unavailable = run.task.includes('BAD_FRAME') && step === 1;
  const png = generatePng(320, 180, run.screenshots.length + 1);
  const b64 = png.toString('base64');
  const frame: FrameRec = {
    // `index` is flat and monotonic across the WHOLE run (all attempts).
    index: run.screenshots.length,
    attempt: run.attempt,
    step,
    taken_at: nowIso(),
    width,
    height,
    mime_type: 'image/png',
    size_bytes: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex'),
    degraded,
    encrypted_at_rest: true,
    image_b64: unavailable ? null : b64,
  };
  run.screenshots.push(frame);
}

/** Terminate the task's ephemeral machine. Ownership-checked and idempotent. */
function completeCleanup(ctx: Ctx, run: RunRec): void {
  const view = run.machine;
  if (!view) return;
  if (view.cleanup_status === 'terminated' || view.cleanup_status === 'failed') return;
  // Documented trigger: termination temporarily unavailable -> stay `retrying`,
  // with the TTL remaining authoritative. Recovery keeps retrying.
  if (run.task.includes('CLEANUP_STUCK')) {
    view.cleanup_status = 'retrying';
    return;
  }
  if (view.id) {
    const machine = ctx.state.machines.get(view.id);
    // Ownership check: only terminate the machine this run actually provisioned.
    if (machine && machine.provisionedForRun === run.id) {
      machine.status = 'terminated';
    }
  }
  view.cleanup_status = 'terminated';
  view.status = 'released';
}

export function finishRun(
  ctx: Ctx,
  run: RunRec,
  status: string,
  extra: Partial<RunRec> = {},
): void {
  run.status = status;
  run.finished_at = nowIso();
  Object.assign(run, extra);

  // Cleanup BEGINS after every terminal outcome, including failure and cancel.
  // It is deliberately not finished here: the docs are explicit that a terminal
  // webhook can be delivered while cleanup is still `terminating`/`retrying`,
  // and that task completion is not proof that termination has finished. The
  // mock reproduces that race so clients are tested against it.
  if (run.mode === 'task' && run.machine) {
    run.machine.cleanup_status = run.task.includes('CLEANUP_STUCK') ? 'retrying' : 'terminating';
    run.cleanupTicks = 0;
  }

  ctx.state.emit(run.id, 'status', { status });
  ctx.state.emit(run.id, 'done', { status, result: run.result, error: run.error });
  if (run.webhook_url && run.webhook_secret) {
    void ctx.state.deliverWebhook(run.webhook_url, run.webhook_secret, `run.${status}`, {
      run: publicRun(run, false),
    });
  }
}

/** One stepper tick. Drives the documented state machine for both modes. */
export function tick(ctx: Ctx, run: RunRec, isTest: boolean): void {
  const { state, opts } = ctx;
  if (state.closed) return;

  // ── cleanup epilogue (task mode only, runs after the terminal transition) ──
  if (TERMINAL.has(run.status)) {
    if (run.mode === 'task' && run.machine && run.machine.cleanup_status !== 'terminated') {
      run.cleanupTicks++;
      if (run.cleanupTicks >= CLEANUP_TICKS) completeCleanup(ctx, run);
    }
    return;
  }

  // ── provisioning prologue (task mode only) ────────────────────────────────
  if (run.mode === 'task' && run.machine && run.machine.status === 'provisioning') {
    // The deadline includes provisioning, so it is checked here too.
    if (run.deadlineAt !== null && opts.now() > run.deadlineAt) {
      run.result = { passed: false, status: 'timed_out', summary: 'Deadline exceeded' };
      finishRun(ctx, run, 'timed_out');
      return;
    }
    run.provisionTicks++;
    if (run.provisionTicks < PROVISION_TICKS) return;

    if (run.task.includes('PROVISION_FAIL')) {
      // A provisioning failure is a terminal TASK error carrying the underlying
      // stable code — never misreported as successful admission.
      run.machine.status = 'failed';
      run.machine.error = {
        code: 'MACHINE_PROVISION_FAILED',
        message: 'The ephemeral machine could not be provisioned',
      };
      run.error = {
        code: 'MACHINE_PROVISION_FAILED',
        message: 'The ephemeral machine could not be provisioned',
      };
      run.result = {
        passed: false,
        status: 'failed',
        summary: 'Provisioning failed before the agent could start.',
      };
      finishRun(ctx, run, 'failed');
      return;
    }

    const osType = run.taskMachineOs;
    const machine: MachineRec = {
      id: isTest ? `mch_test_${hex(4)}` : randomUUID(),
      display_name: `task-${run.id}`,
      status: 'running',
      os_type: osType,
      provider: run.taskMachineProvider,
      desktop_enabled: true,
      cpu_cores: 2,
      memory_gb: 4,
      storage_gb: 20,
      public_ip: '203.0.113.7',
      is_test: isTest,
      created_at: nowIso(),
      metadata: {},
      // The generated machine gets a TTL LONGER than the task deadline as a
      // provider-side leak backstop.
      ttl_minutes: Math.max(
        5,
        Math.ceil(((run.deadlineAt ?? opts.now() + 3_600_000) - opts.now()) / 60_000) + 10,
      ),
      files: new Map(),
      frame: 0,
      provisionedForRun: run.id,
    };
    state.machines.set(machine.id, machine);
    run.machine_id = machine.id;
    run.machine.id = machine.id;
    run.machine.status = 'ready';
    state.emit(run.id, 'status', { status: run.status, machine_id: machine.id });
    return;
  }

  // ── ordinary run loop ──────────────────────────────────────────────────────
  if (run.deadlineAt !== null && opts.now() > run.deadlineAt) {
    run.result = { passed: false, status: 'timed_out', summary: 'Deadline exceeded' };
    finishRun(ctx, run, 'timed_out');
    return;
  }
  if (run.status === 'awaiting_human') return; // paused: nothing to do

  if (run.status === 'queued') {
    run.status = 'running';
    run.started_at = nowIso();
    state.emit(run.id, 'status', { status: 'running' });
    return;
  }

  const step = run.steps_completed + 1;

  // Behavior trigger: the model asks for a human after 2 steps.
  if (run.task.includes('NEEDS_HUMAN') && step === 3 && run.awaiting_human_since === null) {
    const reason = 'The agent needs a human to complete a sensitive step.';
    if (run.mode === 'task') {
      // The endpoint-owned executor INTERCEPTS the handoff: the task never
      // enters awaiting_human and never waits for a person. The runtime
      // suppresses the request and tells the agent to carry on.
      run.awaiting_human_since = nowIso(); // mark as handled so it fires once
      run.awaiting_human_reason = null;
      state.emit(run.id, 'text', {
        text: 'Human handoff requested and suppressed; continuing autonomously.',
      });
    } else if (run.on_awaiting_human === 'fail') {
      run.error = { code: 'AWAITING_HUMAN', message: reason };
      run.result = { passed: false, status: 'failed', summary: reason };
      finishRun(ctx, run, 'failed');
      return;
    } else if (run.on_awaiting_human === 'cancel') {
      finishRun(ctx, run, 'cancelled');
      return;
    } else {
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
  }

  // The frame the agent looks at BEFORE deciding this step.
  captureFrame(run, step);

  // Bill the step. Task runs bill machine runtime separately (see /v1/tasks).
  const cents = stepCents(run.cua_version);
  if (!debitBackground(ctx, isTest, run.mode === 'task' ? 'tasks' : 'runs', cents)) {
    run.error = { code: 'WALLET_EXHAUSTED', message: `Wallet ran dry at step ${step}` };
    run.result = { passed: false, status: 'failed', summary: 'Wallet exhausted mid-run' };
    finishRun(ctx, run, 'failed');
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

  // Behavior trigger: a policy violation fails the ACTIVE run before dispatch.
  if (run.action_policy && run.task.includes('POLICY_VIOLATION') && step >= 2) {
    run.error = {
      code: 'ACTION_POLICY_VIOLATION',
      message: 'Proposed batch violated the pinned action policy',
    };
    run.result = {
      passed: false,
      status: 'failed',
      summary: 'Blocked by action_policy before dispatch.',
    };
    state.emit(run.id, 'error', {
      code: 'ACTION_POLICY_VIOLATION',
      rule: 'blocked_keys',
      message: 'Proposed batch violated the pinned action policy',
    });
    finishRun(ctx, run, 'failed');
    return;
  }

  if (run.task.includes('MUST_FAIL') && step >= 2) {
    run.result = { passed: false, status: 'failed', summary: 'The verifier rejected the outcome.' };
    run.error = { code: 'VERIFICATION_FAILED', message: 'Task verification failed' };
    finishRun(ctx, run, 'failed');
    return;
  }
  if (step >= run.stepsTarget) {
    run.result = { passed: true, status: 'succeeded', summary: `Task completed: ${run.task}` };
    finishRun(ctx, run, 'succeeded');
    return;
  }
  if (step >= run.max_steps) {
    run.result = {
      passed: false,
      status: 'failed',
      summary: 'Hit max_steps before completing the task.',
    };
    finishRun(ctx, run, 'failed');
  }
  void opts;
}

/**
 * Start the background stepper for a run and register the timers so
 * `app.close()` can never leave one behind.
 */
export function startStepper(ctx: Ctx, run: RunRec, isTest: boolean): void {
  const { state, opts } = ctx;
  const timer = state.addTimer(setInterval(() => tick(ctx, run, isTest), opts.tickMs));
  const stopWatch = state.addTimer(
    setInterval(() => {
      // A task keeps ticking past terminal until cleanup settles, so the
      // stopping condition is "terminal AND nothing left to clean up".
      const cleanupSettled =
        run.mode !== 'task' ||
        run.machine === null ||
        run.machine.cleanup_status === 'terminated' ||
        run.machine.cleanup_status === 'failed' ||
        run.machine.cleanup_status === 'retrying';
      if ((TERMINAL.has(run.status) && cleanupSettled) || state.closed) {
        clearInterval(timer);
        clearInterval(stopWatch);
        state.timers.delete(timer);
        state.timers.delete(stopWatch);
      }
    }, opts.tickMs * 4),
  );
}
