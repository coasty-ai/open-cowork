/**
 * The shared agent loop: screenshot → predict → execute actions → repeat until
 * done/fail/cap/abort. Executor- and transport-agnostic: the screen and the
 * predict step are injected, so the same loop drives a local desktop (desktop
 * app), a Coasty cloud machine, or a Playwright page — and predictions can come
 * from a direct CoastyClient session or from the open-cowork backend proxy.
 */
import { normalizeAction, type CuaAction, type PredictStatus, type Usage } from './types';
import { abortableSleep } from './retry';

/** Minimal structural interface a screen target must implement. */
export interface AgentScreen {
  screenshot(): Promise<{ base64: string; width: number; height: number }>;
  execute(action: CuaAction): Promise<void>;
}

export interface PredictStepInput {
  screenshotB64: string;
  instruction: string;
  stepIndex: number;
  width: number;
  height: number;
}

export interface PredictStepResult {
  status: PredictStatus;
  actions: CuaAction[];
  reasoning?: string | null;
  usage?: Usage;
}

export type PredictStepFn = (input: PredictStepInput) => Promise<PredictStepResult>;

export type AgentLoopEvent =
  | { type: 'step-start'; step: number }
  | { type: 'screenshot'; step: number; width: number; height: number; base64: string }
  | {
      type: 'prediction';
      step: number;
      status: PredictStatus;
      reasoning?: string | null;
      actionCount: number;
      costCents: number;
    }
  | { type: 'action'; step: number; action: CuaAction }
  | { type: 'action-error'; step: number; action: CuaAction; error: string }
  /**
   * The loop believes it is making no progress. Emitted BEFORE the run is cut
   * short so a UI can show why a long run ended without a task-level verdict.
   */
  | { type: 'stuck'; step: number; kind: 'idle' | 'repeat'; count: number; detail: string }
  | { type: 'finished'; status: AgentLoopOutcome['status']; stepsUsed: number; reason?: string };

export interface AgentLoopOptions {
  screen: AgentScreen;
  predictStep: PredictStepFn;
  task: string;
  /** Hard cap on predict steps. Default 25. */
  maxSteps?: number;
  /** Pause between steps to let the UI settle. Default 500ms. */
  settleMs?: number;
  /** Abort the loop cooperatively. */
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  /** Injectable sleep (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Consecutive action-execution failures tolerated before giving up. Default 3. */
  maxConsecutiveFailures?: number;

  // ── long-horizon guards ────────────────────────────────────────────────────
  // A step cap alone is a poor stop condition for long runs: an agent that is
  // wedged still burns every remaining step (and every token/credit) before it
  // hits the cap. These three guards end a hopeless run in seconds instead.

  /**
   * Wall-clock budget for the whole run, in ms. Unset = no time limit.
   * Independent of `maxSteps`: a run whose steps are slow (big screenshots, a
   * rate-limited provider) can blow an hour without approaching the step cap.
   */
  deadlineMs?: number;
  /**
   * Consecutive steps returning `continue` with NOTHING to execute before the
   * run is declared stalled. Default 3; 0 disables.
   *
   * This state is never productive — the model said "keep going" and then gave
   * no action, so the next screenshot is identical and it will do it again.
   */
  maxIdleSteps?: number;
  /**
   * Consecutive steps proposing the SAME action sequence before the run is
   * declared stalled. Default 6; 0 disables.
   *
   * Catches the classic wedge: clicking a button that never responds, forever.
   * Steps made only of `scroll`/`wait` are exempt — repeating those is how you
   * page through a long document or wait out a spinner.
   */
  maxRepeatedSteps?: number;
  /** Injectable clock for the deadline (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Pixel grid used when comparing two actions for repetition. Coordinates are
   * quantized to this many pixels, so a model nudging a click by a pixel each
   * step still counts as repeating itself. Default 8.
   */
  repeatCoordTolerance?: number;
}

export interface AgentLoopOutcome {
  /**
   * `stalled` = a long-horizon guard fired (idle or repeating).
   * `timeout` = the wall-clock `deadlineMs` was reached.
   * Both are distinct from `fail`, which means the AGENT reported failure.
   */
  status: 'done' | 'fail' | 'max_steps' | 'aborted' | 'stalled' | 'timeout';
  stepsUsed: number;
  totalCostCents: number;
  reason?: string;
}

/**
 * A comparable fingerprint for one step's actions, used only for repetition
 * detection. Coordinates are quantized so near-identical retries collapse
 * together; text and keys are included verbatim because typing "a" then "b" is
 * genuine progress even though both are `type_text`.
 */
export function stepSignature(actions: CuaAction[], coordTolerance = 8): string {
  const q = (n: number | undefined): number =>
    typeof n === 'number' && Number.isFinite(n) && coordTolerance > 0
      ? Math.round(n / coordTolerance)
      : (n ?? 0);
  return actions
    .map((raw) => {
      const a = normalizeAction(raw);
      switch (a.action_type) {
        case 'click':
          return `click:${q(a.x)},${q(a.y)},${a.button ?? 'left'},${a.clicks ?? 1}`;
        case 'move':
          return `move:${q(a.x)},${q(a.y)}`;
        case 'drag':
          return `drag:${q(a.from_x)},${q(a.from_y)}->${q(a.to_x)},${q(a.to_y)}`;
        case 'type_text':
          return `type:${a.text}`;
        case 'key_press':
          return `key:${a.keys.join('+')}`;
        case 'key_combo':
          return `combo:${a.keys.join('+')}`;
        case 'scroll':
          return `scroll:${a.direction},${a.amount}`;
        case 'wait':
          return `wait:${a.ms}`;
        default:
          return a.action_type;
      }
    })
    .join('|');
}

/** Steps made only of these are legitimately repeated and exempt from the guard. */
const REPEAT_EXEMPT = new Set(['scroll', 'wait']);

function isRepeatExempt(actions: CuaAction[]): boolean {
  return actions.length > 0 && actions.every((a) => REPEAT_EXEMPT.has(a.action_type));
}

/** Run the agent loop to completion. Never throws for task-level failures —
 * those are reported in the outcome; only programmer errors propagate. */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopOutcome> {
  const {
    screen,
    predictStep,
    task,
    maxSteps = 25,
    settleMs = 500,
    signal,
    onEvent,
    sleep = abortableSleep,
    maxConsecutiveFailures = 3,
    deadlineMs,
    maxIdleSteps = 3,
    maxRepeatedSteps = 6,
    now = Date.now,
    repeatCoordTolerance = 8,
  } = opts;

  let totalCostCents = 0;
  let consecutiveFailures = 0;
  let stepsUsed = 0;
  let idleSteps = 0;
  let lastSignature: string | null = null;
  let repeatCount = 1;
  const startedAt = now();

  const finish = (status: AgentLoopOutcome['status'], reason?: string): AgentLoopOutcome => {
    onEvent?.({ type: 'finished', status, stepsUsed, reason });
    return { status, stepsUsed, totalCostCents, reason };
  };

  /** The wall-clock budget, checked before each expensive stage. */
  const outOfTime = (): boolean => deadlineMs !== undefined && now() - startedAt >= deadlineMs;
  const timedOut = (): AgentLoopOutcome =>
    finish('timeout', `Exceeded the ${deadlineMs}ms time budget after ${stepsUsed} step(s)`);

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return finish('aborted', 'Aborted by caller');
    // Check before the screenshot AND before the prediction: both are slow, and
    // a run that is already over budget should not pay for either.
    if (outOfTime()) return timedOut();

    onEvent?.({ type: 'step-start', step });
    const shot = await screen.screenshot();
    onEvent?.({
      type: 'screenshot',
      step,
      width: shot.width,
      height: shot.height,
      base64: shot.base64,
    });

    if (signal?.aborted) return finish('aborted', 'Aborted by caller');
    if (outOfTime()) return timedOut();

    const prediction = await predictStep({
      screenshotB64: shot.base64,
      instruction: task,
      stepIndex: step,
      width: shot.width,
      height: shot.height,
    });
    stepsUsed = step + 1;
    totalCostCents += prediction.usage?.cost_cents ?? 0;
    onEvent?.({
      type: 'prediction',
      step,
      status: prediction.status,
      reasoning: prediction.reasoning,
      actionCount: prediction.actions.length,
      costCents: prediction.usage?.cost_cents ?? 0,
    });

    // ── long-horizon guards ──────────────────────────────────────────────────
    // Evaluated on the PROPOSAL, before executing, so a wedged agent is stopped
    // before it repeats the same useless click one more time. Terminal
    // proposals (done/fail) are handled below and never count as stalling.
    const terminal = prediction.actions.some(
      (a) => a.action_type === 'done' || a.action_type === 'fail',
    );
    if (!terminal && prediction.status === 'continue') {
      if (prediction.actions.length === 0) {
        idleSteps++;
        if (maxIdleSteps > 0 && idleSteps >= maxIdleSteps) {
          const detail = `${idleSteps} consecutive steps returned no action`;
          onEvent?.({ type: 'stuck', step, kind: 'idle', count: idleSteps, detail });
          return finish('stalled', `Agent stopped making progress — ${detail}.`);
        }
      } else {
        idleSteps = 0;
        const signature = stepSignature(prediction.actions, repeatCoordTolerance);
        repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
        lastSignature = signature;
        if (
          maxRepeatedSteps > 0 &&
          repeatCount >= maxRepeatedSteps &&
          !isRepeatExempt(prediction.actions)
        ) {
          const detail = `the same action repeated ${repeatCount} times (${signature})`;
          onEvent?.({ type: 'stuck', step, kind: 'repeat', count: repeatCount, detail });
          return finish('stalled', `Agent appears stuck — ${detail}.`);
        }
      }
    } else {
      idleSteps = 0;
    }

    let stepHadFailure = false;
    for (const action of prediction.actions) {
      if (signal?.aborted) return finish('aborted', 'Aborted by caller');
      // Terminal actions end the loop; they are signals, not executable input.
      if (action.action_type === 'done') {
        return finish('done', prediction.reasoning ?? undefined);
      }
      if (action.action_type === 'fail') {
        const canonical = normalizeAction(action);
        const why = canonical.action_type === 'fail' ? canonical.reason : undefined;
        return finish('fail', why ?? prediction.reasoning ?? 'Agent reported failure');
      }
      onEvent?.({ type: 'action', step, action });
      try {
        await screen.execute(action);
      } catch (err) {
        stepHadFailure = true;
        onEvent?.({
          type: 'action-error',
          step,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
        break; // do not run the remaining actions of a broken step
      }
    }

    if (stepHadFailure) {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return finish('fail', `${consecutiveFailures} consecutive action-execution failures`);
      }
    } else {
      consecutiveFailures = 0;
    }

    if (prediction.status === 'done') return finish('done', prediction.reasoning ?? undefined);
    if (prediction.status === 'fail')
      return finish('fail', prediction.reasoning ?? 'Agent reported failure');

    if (step < maxSteps - 1 && settleMs > 0) {
      try {
        await sleep(settleMs, signal);
      } catch {
        return finish('aborted', 'Aborted by caller');
      }
    }
  }
  return finish('max_steps', `Hit the ${maxSteps}-step cap before completion`);
}
