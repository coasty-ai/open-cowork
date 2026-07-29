/**
 * Long-horizon guards: the conditions that end a wedged run early instead of
 * letting it burn every remaining step (and every token) against the cap.
 *
 * Each guard is tested for BOTH directions — it fires when it should, and it
 * stays out of the way when the agent is genuinely working. The false-positive
 * half matters more: a guard that stops real work is worse than no guard.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  stepSignature,
  type AgentLoopEvent,
  type AgentScreen,
  type CuaAction,
  type PredictStepFn,
  type PredictStepResult,
} from '../src/index';

const click = (x = 100, y = 200): CuaAction => ({ action_type: 'click', params: { x, y } });
const scroll: CuaAction = {
  action_type: 'scroll',
  params: { direction: 'down', amount: 3 },
};
const doneAction: CuaAction = { action_type: 'done', params: {} };

function fakeScreen(): AgentScreen & { executed: CuaAction[] } {
  const executed: CuaAction[] = [];
  return {
    executed,
    screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 1280, height: 720 }),
    execute: async (a) => {
      executed.push(a);
    },
  };
}

/** Always returns the same result — the shape of a wedged agent. */
function constantPredict(result: PredictStepResult): PredictStepFn & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    return result;
  }) as unknown as PredictStepFn & { calls: number };
  fn.calls = 0;
  return fn;
}

const noSleep = async () => {};

// ───────────────────────────────────────────────────────────── idle detection
describe('idle guard', () => {
  it('stops after N consecutive steps that return no action', async () => {
    const predict = constantPredict({ status: 'continue', actions: [] });
    const events: AgentLoopEvent[] = [];

    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 50,
      maxIdleSteps: 3,
      sleep: noSleep,
      onEvent: (e) => events.push(e),
    });

    expect(outcome.status).toBe('stalled');
    expect(outcome.stepsUsed).toBe(3); // stopped at the threshold, not at maxSteps
    expect(predict.calls).toBe(3); // and stopped PAYING for predictions
    expect(outcome.reason).toMatch(/no action/i);
    const stuck = events.find((e) => e.type === 'stuck');
    expect(stuck).toMatchObject({ type: 'stuck', kind: 'idle', count: 3 });
  });

  it('does not fire when empty steps are interleaved with real ones', async () => {
    // Alternating empty/real must reset the counter — an occasional no-op step
    // (a model thinking) is not a stall.
    const script: PredictStepResult[] = [
      { status: 'continue', actions: [] },
      { status: 'continue', actions: [click(10, 10)] },
      { status: 'continue', actions: [] },
      { status: 'continue', actions: [click(20, 20)] },
      { status: 'done', actions: [doneAction] },
    ];
    let i = 0;
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () => script[Math.min(i++, script.length - 1)]!,
      task: 't',
      maxSteps: 20,
      maxIdleSteps: 2,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('done');
  });

  it('is disabled by maxIdleSteps: 0', async () => {
    const predict = constantPredict({ status: 'continue', actions: [] });
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 4,
      maxIdleSteps: 0,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('max_steps');
  });
});

// ─────────────────────────────────────────────────────── repetition detection
describe('repeat guard', () => {
  it('stops an agent proposing the same action over and over', async () => {
    const predict = constantPredict({ status: 'continue', actions: [click(640, 360)] });
    const events: AgentLoopEvent[] = [];

    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 100,
      maxRepeatedSteps: 4,
      sleep: noSleep,
      onEvent: (e) => events.push(e),
    });

    expect(outcome.status).toBe('stalled');
    expect(outcome.stepsUsed).toBe(4);
    expect(outcome.reason).toMatch(/stuck/i);
    expect(events.find((e) => e.type === 'stuck')).toMatchObject({ kind: 'repeat', count: 4 });
  });

  it('treats a near-identical click as a repeat (coordinate jitter)', async () => {
    // A model nudging the click a pixel at a time is still stuck; quantizing
    // coordinates is what catches it.
    let x = 640;
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () => ({ status: 'continue', actions: [click(x++, 360)] }),
      task: 't',
      maxSteps: 100,
      maxRepeatedSteps: 4,
      repeatCoordTolerance: 8,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('stalled');
  });

  it('does NOT fire for repeated scrolling — that is how you read a long page', async () => {
    let steps = 0;
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () =>
        ++steps < 8
          ? { status: 'continue', actions: [scroll] }
          : { status: 'done', actions: [doneAction] },
      task: 't',
      maxSteps: 50,
      maxRepeatedSteps: 3,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('done');
    expect(steps).toBe(8);
  });

  it('does not fire when the agent varies its actions', async () => {
    let n = 0;
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () => {
        n++;
        if (n > 6) return { status: 'done', actions: [doneAction] };
        return { status: 'continue', actions: [click(n * 50, n * 20)] };
      },
      task: 't',
      maxSteps: 50,
      maxRepeatedSteps: 3,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('done');
  });

  it('is disabled by maxRepeatedSteps: 0', async () => {
    const predict = constantPredict({ status: 'continue', actions: [click()] });
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 5,
      maxRepeatedSteps: 0,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('max_steps');
  });
});

// ──────────────────────────────────────────────────────────── wall-clock cap
describe('deadline guard', () => {
  it('stops once the time budget is spent, independent of the step cap', async () => {
    let clock = 0;
    const predict = constantPredict({ status: 'continue', actions: [click()] });
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 1000,
      maxRepeatedSteps: 0, // isolate the deadline from the repeat guard
      deadlineMs: 250,
      now: () => (clock += 100), // 100ms per clock read
      sleep: noSleep,
    });
    expect(outcome.status).toBe('timeout');
    expect(outcome.reason).toMatch(/250ms/);
    expect(outcome.stepsUsed).toBeLessThan(1000);
  });

  it('does not fire when the run finishes inside the budget', async () => {
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () => ({ status: 'done', actions: [doneAction] }),
      task: 't',
      deadlineMs: 10_000,
      now: () => 0,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('done');
  });
});

// ───────────────────────────────────────────────────────────── the signature
describe('stepSignature', () => {
  it('collapses coordinates within the tolerance and separates beyond it', () => {
    expect(stepSignature([click(100, 200)], 8)).toBe(stepSignature([click(103, 202)], 8));
    expect(stepSignature([click(100, 200)], 8)).not.toBe(stepSignature([click(400, 200)], 8));
  });

  it('distinguishes different typed text — typing "a" then "b" is progress', () => {
    const a: CuaAction = { action_type: 'type_text', params: { text: 'a' } };
    const b: CuaAction = { action_type: 'type_text', params: { text: 'b' } };
    expect(stepSignature([a])).not.toBe(stepSignature([b]));
  });

  it('distinguishes different key chords', () => {
    const ctrlC: CuaAction = { action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } };
    const ctrlV: CuaAction = { action_type: 'key_combo', params: { keys: ['ctrl', 'v'] } };
    expect(stepSignature([ctrlC])).not.toBe(stepSignature([ctrlV]));
  });

  it('is order-sensitive across a multi-action step', () => {
    const a = click(10, 10);
    const b = click(90, 90);
    expect(stepSignature([a, b])).not.toBe(stepSignature([b, a]));
  });

  it('tolerance 0 compares exact coordinates', () => {
    expect(stepSignature([click(100, 200)], 0)).not.toBe(stepSignature([click(101, 200)], 0));
  });
});

// ─────────────────────────────────────────────── guards vs. real termination
describe('guards never pre-empt a real verdict', () => {
  it('a repeated action that ends in done still reports done', async () => {
    // The agent repeats, but then declares success before the threshold.
    let n = 0;
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () =>
        ++n < 3
          ? { status: 'continue', actions: [click(5, 5)] }
          : { status: 'done', actions: [doneAction], reasoning: 'all set' },
      task: 't',
      maxRepeatedSteps: 5,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'done', reason: 'all set' });
  });

  it('an explicit fail outranks the idle guard', async () => {
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: async () => ({
        status: 'fail',
        actions: [],
        reasoning: 'login wall',
      }),
      task: 't',
      maxIdleSteps: 1,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'fail', reason: 'login wall' });
  });
});
