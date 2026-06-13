/**
 * WindowsBridge tests. The protocol logic is tested against a fake daemon
 * (a Node child process speaking the same JSON-lines protocol). A real
 * PowerShell smoke test (screen capture only — never input) runs only on
 * Windows AND when COWORK_NATIVE_SMOKE=1, so CI and other platforms skip it.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { pngDimensions, WindowsBridge } from '../src/index';

/** A fake daemon implemented as `node -e`: speaks the bridge protocol. */
const FAKE_DAEMON = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const resp = { id: req.id, ok: true, data: null, error: null };
  switch (req.op) {
    case 'ping': resp.data = 'pong'; break;
    case 'capture': resp.data = { base64: 'QUJD', width: 111, height: 222 }; break;
    case 'screenSize': resp.data = { width: 111, height: 222 }; break;
    case 'move': resp.ok = false; resp.error = 'kaboom'; break;
    default: resp.data = { echoed: req.op, args: req.args }; break;
  }
  process.stdout.write(JSON.stringify(resp) + '\\n');
});
`;

function makeBridge(): WindowsBridge {
  return new WindowsBridge({
    callTimeoutMs: 5000,
    spawnImpl: ((cmd: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, ['-e', FAKE_DAEMON], opts)) as unknown as typeof spawn,
  });
}

describe('WindowsBridge protocol (fake daemon)', () => {
  let bridge: WindowsBridge | null = null;

  afterEach(async () => {
    await bridge?.dispose();
    bridge = null;
  });

  it('round-trips ping/pong', async () => {
    bridge = makeBridge();
    expect(await bridge.ping()).toBe(true);
  });

  it('capture returns the protocol payload', async () => {
    bridge = makeBridge();
    expect(await bridge.capture()).toEqual({ base64: 'QUJD', width: 111, height: 222 });
  });

  it('screenSize works and the daemon is reused across calls', async () => {
    bridge = makeBridge();
    expect(await bridge.screenSize()).toEqual({ width: 111, height: 222 });
    expect(await bridge.screenSize()).toEqual({ width: 111, height: 222 });
  });

  it('input ops resolve through the protocol', async () => {
    bridge = makeBridge();
    await bridge.click(1, 2, 'left', 1);
    await bridge.typeText('hello');
    await bridge.keyCombo(['ctrl', 'c']);
    await bridge.scroll('down', 3);
    await bridge.drag(0, 0, 5, 5, 'left');
    await bridge.keyPress(['enter']);
  });

  it('a failed daemon op rejects with its error message', async () => {
    bridge = makeBridge();
    await expect(bridge.moveMouse(1, 1)).rejects.toThrow(/kaboom/);
  });

  it('dispose kills the daemon; the bridge restarts transparently on next use', async () => {
    bridge = makeBridge();
    expect(await bridge.ping()).toBe(true);
    await bridge.dispose();
    expect(await bridge.ping()).toBe(true);
  });
});

/**
 * A fake child process that records every JSON request written to stdin and
 * auto-replies, echoing the op + args back as the response data. Lets us assert
 * the EXACT coordinates/region the daemon receives (the multi-monitor offset).
 */
function fakeDaemon() {
  const sent: { op: string; args: Record<string, unknown> }[] = [];
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stdout.setEncoding = () => undefined;
  const proc = {
    pid: 4321,
    exitCode: null as number | null,
    stdout,
    stdin: {
      write(payload: string, cb?: (err?: Error | null) => void) {
        const req = JSON.parse(payload.trim()) as {
          id: number;
          op: string;
          args: Record<string, unknown>;
        };
        sent.push({ op: req.op, args: req.args });
        queueMicrotask(() =>
          stdout.emit(
            'data',
            JSON.stringify({ id: req.id, ok: true, data: { op: req.op, args: req.args } }) + '\n',
          ),
        );
        cb?.();
        return true;
      },
      end() {},
    },
    on() {
      return proc;
    },
    kill() {},
  };
  return { proc, sent };
}

describe('WindowsBridge — region targeting (multi-monitor fix)', () => {
  // A 2560×1440 monitor to the RIGHT of a 1920-wide primary.
  const REGION = { x: 1920, y: 0, width: 2560, height: 1440 };

  function regionBridge() {
    const { proc, sent } = fakeDaemon();
    const bridge = new WindowsBridge({
      region: REGION,
      spawnImpl: (() => proc) as unknown as typeof spawn,
    });
    return { bridge, sent };
  }

  it('capture asks the daemon for exactly the target rect', async () => {
    const { bridge, sent } = regionBridge();
    await bridge.capture();
    expect(sent.at(-1)).toEqual({ op: 'capture', args: REGION });
  });

  it('screenSize returns the region size without a daemon round-trip', async () => {
    const { bridge, sent } = regionBridge();
    expect(await bridge.screenSize()).toEqual({ width: 2560, height: 1440 });
    expect(sent.some((s) => s.op === 'screenSize')).toBe(false);
  });

  it('click coordinates are offset by the region origin', async () => {
    const { bridge, sent } = regionBridge();
    await bridge.click(10, 20, 'left', 1);
    expect(sent.at(-1)).toEqual({
      op: 'click',
      args: { x: 1930, y: 20, button: 'left', clicks: 1 },
    });
  });

  it('drag + scroll coordinates are offset too', async () => {
    const { bridge, sent } = regionBridge();
    await bridge.drag(0, 0, 100, 50, 'left');
    expect(sent.at(-1)!.args).toMatchObject({ fromX: 1920, fromY: 0, toX: 2020, toY: 50 });
    await bridge.scroll('down', 3, 5, 5);
    expect(sent.at(-1)!.args).toMatchObject({ x: 1925, y: 5 });
  });

  it('with no region, coordinates are unchanged and capture sends no rect', async () => {
    const { proc, sent } = fakeDaemon();
    const bridge = new WindowsBridge({ spawnImpl: (() => proc) as unknown as typeof spawn });
    await bridge.capture();
    expect(sent.at(-1)).toEqual({ op: 'capture', args: {} });
    await bridge.click(10, 20, 'left', 1);
    expect(sent.at(-1)!.args).toMatchObject({ x: 10, y: 20 });
  });
});

describe('pngDimensions', () => {
  it('parses width/height from a real PNG header', () => {
    const buf = new Uint8Array(25);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // magic
    const view = new DataView(buf.buffer);
    view.setUint32(8, 13); // IHDR length
    buf.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
    view.setUint32(16, 2); // width
    view.setUint32(20, 3); // height
    expect(pngDimensions(buf)).toEqual({ width: 2, height: 3 });
  });
  it('rejects non-PNG data', () => {
    expect(() =>
      pngDimensions(new TextEncoder().encode('definitely not a png, far too plain')),
    ).toThrow(/magic/);
    expect(() => pngDimensions(new Uint8Array(4))).toThrow(/short/);
  });
});

// Real-PowerShell smoke test: capture + screenSize only. Opt-in, never moves the mouse.
const runNative = process.platform === 'win32' && process.env.COWORK_NATIVE_SMOKE === '1';
describe.runIf(runNative)('WindowsBridge native smoke (opt-in)', () => {
  it('captures a real PNG of the primary screen', async () => {
    const bridge = new WindowsBridge();
    try {
      expect(await bridge.ping()).toBe(true);
      const size = await bridge.screenSize();
      expect(size.width).toBeGreaterThan(100);
      const shot = await bridge.capture();
      const bytes = Buffer.from(shot.base64, 'base64');
      expect(pngDimensions(bytes)).toEqual({ width: shot.width, height: shot.height });
    } finally {
      await bridge.dispose();
    }
  }, 60_000);
});
