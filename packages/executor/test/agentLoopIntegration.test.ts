/**
 * End-to-end contract test: core's `runAgentLoop` driving each of the three
 * real Executor implementations, backed by a fake transport / NativeBridge /
 * PageLike. A scripted predictStep yields continue → continue → done; we assert
 * (a) the loop reports status 'done' with the right stepsUsed, and (b) the
 * executor received the mapped low-level calls in order. Sleep is injected so
 * no real timers fire and vitest exits cleanly.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runAgentLoop,
  type CuaAction,
  type MachineActionRequest,
  type MachineActionResponse,
  type MachineScreenshotResponse,
  type PredictStepFn,
  type PredictStepResult,
} from '@open-cowork/core';
import {
  BrowserExecutor,
  LocalExecutor,
  RemoteMachineExecutor,
  type NativeBridge,
  type PageLike,
  type RemoteMachineTransport,
} from '../src/index';

/** A scripted predictStep: one PredictStepResult per call, in order. */
function scriptedPredict(steps: PredictStepResult[]): { fn: PredictStepFn; inputs: unknown[] } {
  const inputs: unknown[] = [];
  let i = 0;
  const fn: PredictStepFn = async (input) => {
    inputs.push(input);
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step!;
  };
  return { fn, inputs };
}

function cont(actions: CuaAction[]): PredictStepResult {
  return { status: 'continue', actions };
}
function done(): PredictStepResult {
  return { status: 'done', actions: [{ action_type: 'done', params: {} }], reasoning: 'all set' };
}

const noSleep = vi.fn(async () => {});

describe('runAgentLoop ↔ RemoteMachineExecutor', () => {
  it('drives the transport in order and finishes done', async () => {
    const actions: MachineActionRequest[] = [];
    let shots = 0;
    const transport: RemoteMachineTransport = {
      async machineScreenshot(machineId): Promise<MachineScreenshotResponse> {
        shots++;
        return {
          machine_id: machineId,
          image_b64: 'BASE64SHOT',
          mime_type: 'image/png',
          width: 1280,
          height: 720,
          captured_at: '2026-06-12T00:00:00Z',
          request_id: `req_${shots}`,
        };
      },
      async machineAction(machineId, req): Promise<MachineActionResponse> {
        actions.push(req);
        return {
          machine_id: machineId,
          command: req.command,
          success: true,
          result: {},
          error: null,
          duration_ms: 1,
          screenshot: null,
          request_id: 'r',
        };
      },
    };
    const ex = new RemoteMachineExecutor({ machineId: 'mch_x', transport, sleep: noSleep });
    const { fn, inputs } = scriptedPredict([
      cont([{ action_type: 'click', params: { x: 1, y: 2 } }]),
      cont([{ action_type: 'type_text', params: { text: 'hi' } }]),
      done(),
    ]);

    const outcome = await runAgentLoop({
      screen: ex,
      predictStep: fn,
      task: 'do the thing',
      sleep: noSleep,
    });

    expect(outcome.status).toBe('done');
    expect(outcome.stepsUsed).toBe(3);
    expect(outcome.reason).toBe('all set');
    // The loop screenshots before each predict (3 steps).
    expect(shots).toBe(3);
    // Only the two non-terminal actions hit the transport, in order.
    expect(actions.map((a) => a.command)).toEqual(['click', 'type']);
    expect(actions[0]!.parameters).toMatchObject({ x: 1, y: 2 });
    // The loop forwards each fresh screenshot's base64 into predict.
    expect((inputs[0] as { screenshotB64: string }).screenshotB64).toBe('BASE64SHOT');
    expect((inputs[2] as { stepIndex: number }).stepIndex).toBe(2);
  });
});

describe('runAgentLoop ↔ LocalExecutor', () => {
  it('drives a fake NativeBridge in order and finishes done', async () => {
    const calls: string[] = [];
    const bridge: NativeBridge = {
      async capture() {
        calls.push('capture');
        return { base64: 'LOCALSHOT', width: 1000, height: 1000 };
      },
      async screenSize() {
        return { width: 1000, height: 1000 };
      },
      async click(x, y, button, clicks) {
        calls.push(`click(${x},${y},${button},${clicks})`);
      },
      async moveMouse(x, y) {
        calls.push(`move(${x},${y})`);
      },
      async drag(fx, fy, tx, ty, b) {
        calls.push(`drag(${fx},${fy},${tx},${ty},${b})`);
      },
      async typeText(t) {
        calls.push(`type(${t})`);
      },
      async keyPress(keys) {
        calls.push(`keyPress(${keys.join('+')})`);
      },
      async keyCombo(keys) {
        calls.push(`keyCombo(${keys.join('+')})`);
      },
      async scroll(d, a, x, y) {
        calls.push(`scroll(${d},${a},${x ?? '-'},${y ?? '-'})`);
      },
      async dispose() {
        calls.push('dispose');
      },
    };
    const ex = new LocalExecutor({ bridge, sleep: noSleep });
    const { fn } = scriptedPredict([
      cont([{ action_type: 'click', params: { x: 100, y: 200 } }]),
      cont([{ action_type: 'type_text', params: { text: 'abc' } }]),
      done(),
    ]);

    const outcome = await runAgentLoop({ screen: ex, predictStep: fn, task: 't', sleep: noSleep });

    expect(outcome.status).toBe('done');
    expect(outcome.stepsUsed).toBe(3);
    // 1:1 coordinate space (capture == screen), so coords pass through.
    expect(calls.filter((c) => c.startsWith('click') || c.startsWith('type'))).toEqual([
      'click(100,200,left,1)',
      'type(abc)',
    ]);
  });
});

describe('runAgentLoop ↔ BrowserExecutor', () => {
  it('drives a fake PageLike in order and finishes done', async () => {
    const calls: string[] = [];
    const page: PageLike = {
      async screenshot() {
        calls.push('screenshot');
        return new TextEncoder().encode('PNG');
      },
      viewportSize: () => ({ width: 1280, height: 720 }),
      mouse: {
        async click(x, y, o) {
          calls.push(`click(${x},${y},${o?.button ?? 'left'},${o?.clickCount ?? 1})`);
        },
        async move(x, y) {
          calls.push(`move(${x},${y})`);
        },
        async down(o) {
          calls.push(`down(${o?.button ?? 'left'})`);
        },
        async up(o) {
          calls.push(`up(${o?.button ?? 'left'})`);
        },
        async wheel(dx, dy) {
          calls.push(`wheel(${dx},${dy})`);
        },
      },
      keyboard: {
        async type(t) {
          calls.push(`type(${t})`);
        },
        async press(k) {
          calls.push(`press(${k})`);
        },
      },
      async waitForTimeout(ms) {
        calls.push(`wait(${ms})`);
      },
    };
    const ex = new BrowserExecutor({ page });
    const { fn } = scriptedPredict([
      cont([{ action_type: 'click', params: { x: 5, y: 6 } }]),
      cont([{ action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } }]),
      done(),
    ]);

    const outcome = await runAgentLoop({ screen: ex, predictStep: fn, task: 't', sleep: noSleep });

    expect(outcome.status).toBe('done');
    expect(outcome.stepsUsed).toBe(3);
    expect(calls.filter((c) => !c.startsWith('screenshot'))).toEqual([
      'click(5,6,left,1)',
      'press(Control+c)',
    ]);
  });
});

describe('runAgentLoop terminal mapping', () => {
  it("a predicted 'fail' from a step surfaces as outcome.fail with reason", async () => {
    const transport: RemoteMachineTransport = {
      async machineScreenshot(id) {
        return {
          machine_id: id,
          image_b64: 'X',
          mime_type: 'image/png',
          width: 10,
          height: 10,
          captured_at: '',
          request_id: '',
        };
      },
      async machineAction(id, req) {
        return {
          machine_id: id,
          command: req.command,
          success: true,
          result: {},
          error: null,
          duration_ms: 0,
          screenshot: null,
          request_id: '',
        };
      },
    };
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: noSleep });
    const { fn } = scriptedPredict([
      { status: 'fail', actions: [{ action_type: 'fail', params: { reason: 'blocked' } }] },
    ]);
    const outcome = await runAgentLoop({ screen: ex, predictStep: fn, task: 't', sleep: noSleep });
    expect(outcome.status).toBe('fail');
    expect(outcome.stepsUsed).toBe(1);
    expect(outcome.reason).toBe('blocked');
  });
});
