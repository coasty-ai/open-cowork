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
  | { type: 'prediction'; step: number; status: PredictStatus; reasoning?: string | null; actionCount: number; costCents: number }
  | { type: 'action'; step: number; action: CuaAction }
  | { type: 'action-error'; step: number; action: CuaAction; error: string }
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
}

export interface AgentLoopOutcome {
  status: 'done' | 'fail' | 'max_steps' | 'aborted';
  stepsUsed: number;
  totalCostCents: number;
  reason?: string;
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
  } = opts;

  let totalCostCents = 0;
  let consecutiveFailures = 0;
  let stepsUsed = 0;

  const finish = (status: AgentLoopOutcome['status'], reason?: string): AgentLoopOutcome => {
    onEvent?.({ type: 'finished', status, stepsUsed, reason });
    return { status, stepsUsed, totalCostCents, reason };
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return finish('aborted', 'Aborted by caller');

    onEvent?.({ type: 'step-start', step });
    const shot = await screen.screenshot();
    onEvent?.({ type: 'screenshot', step, width: shot.width, height: shot.height, base64: shot.base64 });

    if (signal?.aborted) return finish('aborted', 'Aborted by caller');

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
    if (prediction.status === 'fail') return finish('fail', prediction.reasoning ?? 'Agent reported failure');

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
