import { describe, expect, it, vi } from 'vitest';
import { LocalExecutor, UnsupportedActionError, type NativeBridge } from '../src/index';

interface FakeBridgeOptions {
  captureSize?: { width: number; height: number };
  screenSize?: { width: number; height: number };
}

function fakeBridge(opts: FakeBridgeOptions = {}) {
  const capture = opts.captureSize ?? { width: 1280, height: 720 };
  const screen = opts.screenSize ?? capture;
  const calls: string[] = [];
  const bridge: NativeBridge = {
    async capture() {
      calls.push('capture');
      return { base64: 'iVBOR' + 'A'.repeat(120), ...capture };
    },
    async screenSize() {
      return screen;
    },
    async click(x, y, button, clicks) {
      calls.push(`click(${x},${y},${button},${clicks})`);
    },
    async moveMouse(x, y) {
      calls.push(`move(${x},${y})`);
    },
    async drag(fx, fy, tx, ty, button) {
      calls.push(`drag(${fx},${fy},${tx},${ty},${button})`);
    },
    async typeText(text) {
      calls.push(`type(${text})`);
    },
    async keyPress(keys) {
      calls.push(`keyPress(${keys.join('+')})`);
    },
    async keyCombo(keys) {
      calls.push(`keyCombo(${keys.join('+')})`);
    },
    async scroll(direction, amount, x, y) {
      calls.push(`scroll(${direction},${amount},${x ?? '-'},${y ?? '-'})`);
    },
    async dispose() {
      calls.push('dispose');
    },
  };
  return { bridge, calls };
}

describe('LocalExecutor', () => {
  it('passes screenshots through and reports kind local', async () => {
    const { bridge } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    expect(ex.kind).toBe('local');
    const shot = await ex.screenshot();
    expect(shot).toMatchObject({ width: 1280, height: 720 });
  });

  it('1:1 coordinates when capture size equals screen size', async () => {
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.screenshot();
    await ex.execute({ action_type: 'click', params: { x: 100, y: 200 } });
    expect(calls).toContain('click(100,200,left,1)');
  });

  it('scales model coordinates when the screen differs from the capture (DPI)', async () => {
    // Model saw a 1280x720 screenshot; real input space is 2560x1440 → 2x.
    const { bridge, calls } = fakeBridge({
      captureSize: { width: 1280, height: 720 },
      screenSize: { width: 2560, height: 1440 },
    });
    const ex = new LocalExecutor({ bridge });
    await ex.screenshot();
    await ex.execute({ action_type: 'click', params: { x: 640, y: 360 } });
    expect(calls).toContain('click(1280,720,left,1)');
  });

  it('scales drag endpoints too', async () => {
    const { bridge, calls } = fakeBridge({
      captureSize: { width: 1000, height: 500 },
      screenSize: { width: 2000, height: 1000 },
    });
    const ex = new LocalExecutor({ bridge });
    await ex.screenshot();
    await ex.execute({
      action_type: 'drag',
      params: { from_x: 10, from_y: 20, to_x: 30, to_y: 40 },
    });
    expect(calls).toContain('drag(20,40,60,80,left)');
  });

  it('captures once for scaling when execute comes before any screenshot', async () => {
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.execute({ action_type: 'click', params: { x: 5, y: 5 } });
    expect(calls.filter((c) => c === 'capture')).toHaveLength(1);
  });

  it('dispatches keyboard + scroll + wait actions', async () => {
    const { bridge, calls } = fakeBridge();
    const sleep = vi.fn(async () => {});
    const ex = new LocalExecutor({ bridge, sleep });
    await ex.execute({ action_type: 'type_text', params: { text: 'abc' } });
    await ex.execute({ action_type: 'key_press', params: { key: 'enter' } });
    await ex.execute({ action_type: 'key_combo', params: { keys: ['ctrl', 'v'] } });
    await ex.execute({ action_type: 'scroll', params: { direction: 'down', amount: 4 } });
    await ex.execute({ action_type: 'wait', params: { ms: 300 } });
    expect(calls).toEqual(
      expect.arrayContaining([
        'type(abc)',
        'keyPress(enter)',
        'keyCombo(ctrl+v)',
        'scroll(down,4,-,-)',
      ]),
    );
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it('scroll with coordinates scales the point', async () => {
    const { bridge, calls } = fakeBridge({
      captureSize: { width: 100, height: 100 },
      screenSize: { width: 200, height: 200 },
    });
    const ex = new LocalExecutor({ bridge });
    await ex.screenshot();
    await ex.execute({
      action_type: 'scroll',
      params: { x: 50, y: 50, direction: 'up', amount: 1 },
    });
    expect(calls).toContain('scroll(up,1,100,100)');
  });

  it('refuses raw code on the local machine', async () => {
    const { bridge } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await expect(
      ex.execute({ action_type: 'raw', params: { code: 'os.system("format c:")' } }),
    ).rejects.toBeInstanceOf(UnsupportedActionError);
  });

  it('dispose releases the bridge', async () => {
    const { bridge, calls } = fakeBridge();
    const ex = new LocalExecutor({ bridge });
    await ex.dispose();
    expect(calls).toContain('dispose');
  });
});
