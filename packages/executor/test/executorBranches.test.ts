/**
 * Branch coverage top-up for the three executors: variants and edge cases the
 * existing per-executor tests don't already assert (dispose no-ops, unknown
 * action types → UnsupportedActionError, dimensions() behaviour, move,
 * done/fail signals, scroll-with-coords on the remote, drag x1/y1 variant,
 * multi-key key_press, capture-once caching). No duplication of existing cases.
 */
import { describe, expect, it } from 'vitest';
import type {
  CuaAction,
  MachineActionRequest,
  MachineActionResponse,
  MachineScreenshotResponse,
} from '@open-cowork/core';
import {
  BrowserExecutor,
  LocalExecutor,
  RemoteMachineExecutor,
  toPlaywrightKey,
  type NativeBridge,
  type PageLike,
  type RemoteMachineTransport,
} from '../src/index';

// An action_type the executors don't handle — hits the `default` branch.
const bogus = { action_type: 'levitate', params: {} } as unknown as CuaAction;

// ── LocalExecutor ─────────────────────────────────────────────────────────────

function fakeBridge(screen = { width: 1280, height: 720 }) {
  const calls: string[] = [];
  let captures = 0;
  let screenSizes = 0;
  const bridge: NativeBridge = {
    async capture() {
      captures++;
      return { base64: 'CAP', width: 1280, height: 720 };
    },
    async screenSize() {
      screenSizes++;
      return screen;
    },
    async click(x, y, b, c) {
      calls.push(`click(${x},${y},${b},${c})`);
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
  return { bridge, calls, captures: () => captures, screenSizes: () => screenSizes };
}

describe('LocalExecutor extra branches', () => {
  it('dimensions() delegates to bridge.screenSize without capturing', async () => {
    const { bridge, captures, screenSizes } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    expect(await ex.dimensions()).toEqual({ width: 1280, height: 720 });
    expect(captures()).toBe(0);
    expect(screenSizes()).toBe(1);
  });

  it('move action scales then calls moveMouse', async () => {
    const { bridge, calls } = fakeBridge({ width: 2560, height: 1440 });
    const ex = new LocalExecutor({ bridge });
    await ex.screenshot(); // captureDims = 1280x720, screen 2x → scale 2
    await ex.execute({ action_type: 'move', params: { x: 10, y: 20 } });
    expect(calls).toContain('move(20,40)');
  });

  it('reuses the cached capture dims across multiple scaled actions', async () => {
    const { bridge, captures } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.execute({ action_type: 'click', params: { x: 1, y: 1 } });
    await ex.execute({ action_type: 'click', params: { x: 2, y: 2 } });
    // Only the first action triggers the implicit capture for scaling.
    expect(captures()).toBe(1);
  });

  it('done and fail are no-ops (no bridge calls)', async () => {
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.execute({ action_type: 'done', params: {} });
    await ex.execute({ action_type: 'fail', params: { reason: 'x' } });
    expect(calls).toHaveLength(0);
  });

  it('unknown action type is rejected by normalizeAction before reaching the bridge', async () => {
    // normalizeAction throws on unknown types, so executors fail loudly rather
    // than silently no-oping. (The executor's own UnsupportedActionError default
    // is a belt-and-braces guard for that already-unreachable case.)
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await expect(ex.execute(bogus)).rejects.toThrow(/Unknown action_type: levitate/);
    expect(calls).toHaveLength(0);
  });

  it('multi-key key_press forwards the whole array to the bridge', async () => {
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.execute({ action_type: 'key_press', params: { keys: ['ctrl', 'a', 'enter'] } });
    expect(calls).toContain('keyPress(ctrl+a+enter)');
  });
});

// ── RemoteMachineExecutor ─────────────────────────────────────────────────────

function fakeTransport() {
  const actions: MachineActionRequest[] = [];
  const transport: RemoteMachineTransport = {
    async machineScreenshot(id): Promise<MachineScreenshotResponse> {
      return {
        machine_id: id,
        image_b64: 'IMG',
        mime_type: 'image/png',
        width: 800,
        height: 600,
        captured_at: '',
        request_id: '',
      };
    },
    async machineAction(id, req): Promise<MachineActionResponse> {
      actions.push(req);
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
  return { transport, actions };
}

describe('RemoteMachineExecutor extra branches', () => {
  it('dispose() resolves without touching the transport', async () => {
    const { transport, actions } = fakeTransport();
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: async () => {} });
    await expect(ex.dispose()).resolves.toBeUndefined();
    expect(actions).toHaveLength(0);
  });

  it('scroll forwards coordinates when present', async () => {
    const { transport, actions } = fakeTransport();
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: async () => {} });
    await ex.execute({
      action_type: 'scroll',
      params: { x: 40, y: 50, direction: 'up', amount: 2 },
    });
    expect(actions[0]!.parameters).toEqual({ x: 40, y: 50, direction: 'up', amount: 2 });
  });

  it('drag accepts the x1/y1/x2/y2 variant (normalized to from/to)', async () => {
    const { transport, actions } = fakeTransport();
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: async () => {} });
    await ex.execute({ action_type: 'drag', params: { x1: 1, y1: 2, x2: 3, y2: 4 } });
    expect(actions[0]!.parameters).toEqual({
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
      button: 'left',
    });
  });

  it('unknown action type is rejected by normalizeAction (no transport call)', async () => {
    const { transport, actions } = fakeTransport();
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: async () => {} });
    await expect(ex.execute(bogus)).rejects.toThrow(/Unknown action_type: levitate/);
    expect(actions).toHaveLength(0);
  });

  it('dimensions() returns the cached dims after a screenshot without re-fetching', async () => {
    let shots = 0;
    const transport: RemoteMachineTransport = {
      async machineScreenshot(id): Promise<MachineScreenshotResponse> {
        shots++;
        return {
          machine_id: id,
          image_b64: 'IMG',
          mime_type: 'image/png',
          width: 640,
          height: 480,
          captured_at: '',
          request_id: '',
        };
      },
      async machineAction(id, req): Promise<MachineActionResponse> {
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
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep: async () => {} });
    await ex.screenshot();
    expect(await ex.dimensions()).toEqual({ width: 640, height: 480 });
    expect(shots).toBe(1); // cached, not re-fetched
  });
});

// ── BrowserExecutor ───────────────────────────────────────────────────────────

function fakePage(
  viewport: { width: number; height: number } | null = { width: 1280, height: 720 },
) {
  const calls: string[] = [];
  const page: PageLike = {
    async screenshot() {
      calls.push('screenshot');
      return new TextEncoder().encode('PNG');
    },
    viewportSize: () => viewport,
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
  return { page, calls };
}

describe('BrowserExecutor extra branches', () => {
  it('reports kind browser and dispose() is a no-op', async () => {
    const { page } = fakePage();
    const ex = new BrowserExecutor({ page });
    expect(ex.kind).toBe('browser');
    await expect(ex.dispose()).resolves.toBeUndefined();
  });

  it('done and fail are no-ops', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({ action_type: 'done', params: {} });
    await ex.execute({ action_type: 'fail', params: { reason: 'x' } });
    expect(calls).toHaveLength(0);
  });

  it('unknown action type is rejected by normalizeAction (no page call)', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await expect(ex.execute(bogus)).rejects.toThrow(/Unknown action_type: levitate/);
    expect(calls).toHaveLength(0);
  });

  it('multi-key key_press presses each mapped key in order', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({ action_type: 'key_press', params: { keys: ['esc', 'a', 'f5', 'home'] } });
    expect(calls).toEqual(['press(Escape)', 'press(a)', 'press(F5)', 'press(Home)']);
  });

  it('scroll right with coordinates moves then wheels +X', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({
      action_type: 'scroll',
      params: { x: 1, y: 2, direction: 'right', amount: 1 },
    });
    expect(calls).toEqual(['move(1,2)', 'wheel(120,0)']);
  });

  it('scroll up without coordinates wheels -Y and does not move', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({ action_type: 'scroll', params: { direction: 'up', amount: 2 } });
    expect(calls).toEqual(['wheel(0,-240)']);
  });

  it('drag with the from_x/from_y variant moves/downs/moves/ups', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({
      action_type: 'drag',
      params: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: 'middle' },
    });
    expect(calls).toEqual(['move(1,2)', 'down(middle)', 'move(3,4)', 'up(middle)']);
  });

  it('screenshot falls back to the default viewport (1280x720) when none', async () => {
    const { page } = fakePage(null);
    const ex = new BrowserExecutor({ page });
    const shot = await ex.screenshot();
    expect(shot).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('toPlaywrightKey extra cases', () => {
  it('uppercases unknown multi-char keys (Playwright convention)', () => {
    expect(toPlaywrightKey('insert')).toBe('Insert');
  });
  it('passes single unknown chars through unchanged', () => {
    expect(toPlaywrightKey('/')).toBe('/');
  });
  it('maps f-keys regardless of case', () => {
    expect(toPlaywrightKey('F12')).toBe('F12');
    expect(toPlaywrightKey('f1')).toBe('F1');
  });
});
