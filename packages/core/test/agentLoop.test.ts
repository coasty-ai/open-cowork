import { describe, expect, it, vi } from 'vitest';
import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentScreen,
  type CuaAction,
  type PredictStepFn,
  type PredictStepResult,
} from '../src/index';

const click: CuaAction = { action_type: 'click', params: { x: 1, y: 2 } };
const doneAction: CuaAction = { action_type: 'done', params: {} };

function fakeScreen(overrides: Partial<AgentScreen> = {}): AgentScreen & { executed: CuaAction[] } {
  const executed: CuaAction[] = [];
  return {
    executed,
    screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 1280, height: 720 }),
    execute: async (a) => {
      executed.push(a);
    },
    ...overrides,
  };
}

/** predictStep that yields the given results in order; repeats the last. */
function scriptedPredict(results: PredictStepResult[]): PredictStepFn & { calls: number[] } {
  const calls: number[] = [];
  const fn = (async (input) => {
    calls.push(input.stepIndex);
    return results[Math.min(calls.length - 1, results.length - 1)]!;
  }) as PredictStepFn & { calls: number[] };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

describe('runAgentLoop', () => {
  it('continue → done: executes actions, accumulates cost, finishes done', async () => {
    const screen = fakeScreen();
    const predict = scriptedPredict([
      { status: 'continue', actions: [click, click], usage: { credits_charged: 5, cost_cents: 5 } },
      {
        status: 'done',
        actions: [doneAction],
        reasoning: 'finished',
        usage: { credits_charged: 5, cost_cents: 5 },
      },
    ]);
    const outcome = await runAgentLoop({
      screen,
      predictStep: predict,
      task: 'do it',
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'done', stepsUsed: 2, totalCostCents: 10 });
    expect(screen.executed).toHaveLength(2); // the done action is a signal, not executed
  });

  it('status done without a done action also finishes', async () => {
    const predict = scriptedPredict([{ status: 'done', actions: [], reasoning: 'all set' }]);
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'done', reason: 'all set', stepsUsed: 1 });
  });

  it('fail action carries its reason into the outcome', async () => {
    const failAction: CuaAction = { action_type: 'fail', params: { reason: 'login wall' } };
    const predict = scriptedPredict([{ status: 'fail', actions: [failAction] }]);
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'fail', reason: 'login wall' });
  });

  it('stops at maxSteps', async () => {
    const predict = scriptedPredict([{ status: 'continue', actions: [click] }]);
    const outcome = await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      maxSteps: 3,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('max_steps');
    expect(outcome.stepsUsed).toBe(3);
  });

  it('aborts cooperatively via AbortSignal', async () => {
    const controller = new AbortController();
    const predict = scriptedPredict([{ status: 'continue', actions: [click] }]);
    let steps = 0;
    const screen = fakeScreen({
      screenshot: async () => {
        steps++;
        if (steps === 2) controller.abort();
        return { base64: 'x'.repeat(200), width: 100, height: 100 };
      },
    });
    const outcome = await runAgentLoop({
      screen,
      predictStep: predict,
      task: 't',
      signal: controller.signal,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('aborted');
  });

  it('executor errors: skips the rest of the step, fails after 3 consecutive failures', async () => {
    const errors: AgentLoopEvent[] = [];
    const screen = fakeScreen({
      execute: async () => {
        throw new Error('SendInput failed');
      },
    });
    const predict = scriptedPredict([{ status: 'continue', actions: [click, click] }]);
    const outcome = await runAgentLoop({
      screen,
      predictStep: predict,
      task: 't',
      sleep: noSleep,
      onEvent: (e) => {
        if (e.type === 'action-error') errors.push(e);
      },
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.reason).toMatch(/consecutive/);
    expect(errors).toHaveLength(3); // one per step; second action of each step skipped
  });

  it('a successful step resets the consecutive-failure counter', async () => {
    let call = 0;
    const screen = fakeScreen({
      execute: async () => {
        call++;
        if (call % 2 === 1) throw new Error('flaky'); // fail, ok, fail, ok...
      },
    });
    const predict = scriptedPredict([
      { status: 'continue', actions: [click] },
      { status: 'continue', actions: [click] },
      { status: 'continue', actions: [click] },
      { status: 'continue', actions: [click] },
      { status: 'done', actions: [] },
    ]);
    const outcome = await runAgentLoop({ screen, predictStep: predict, task: 't', sleep: noSleep });
    expect(outcome.status).toBe('done');
  });

  it('sleeps settleMs between steps (injectable)', async () => {
    const sleep = vi.fn(noSleep);
    const predict = scriptedPredict([
      { status: 'continue', actions: [click] },
      { status: 'done', actions: [] },
    ]);
    await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      settleMs: 123,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(123, undefined);
  });

  it('emits the documented event sequence', async () => {
    const types: string[] = [];
    const predict = scriptedPredict([
      { status: 'continue', actions: [click] },
      { status: 'done', actions: [doneAction], reasoning: 'ok' },
    ]);
    await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 't',
      sleep: noSleep,
      onEvent: (e) => types.push(e.type),
    });
    expect(types).toEqual([
      'step-start',
      'screenshot',
      'prediction',
      'action',
      'step-start',
      'screenshot',
      'prediction',
      'finished',
    ]);
  });

  it('passes the screenshot and task to predictStep', async () => {
    const seen: { instruction?: string; width?: number } = {};
    const predict: PredictStepFn = async (input) => {
      seen.instruction = input.instruction;
      seen.width = input.width;
      return { status: 'done', actions: [] };
    };
    await runAgentLoop({
      screen: fakeScreen(),
      predictStep: predict,
      task: 'open calculator',
      sleep: noSleep,
    });
    expect(seen).toEqual({ instruction: 'open calculator', width: 1280 });
  });
});
