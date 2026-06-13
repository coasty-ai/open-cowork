/**
 * The cross-platform crown jewel: prove the macOS/Linux NativeBridges build the
 * EXACT shell commands the agent needs, without any real hardware or processes.
 *
 * `unixBridges.ts` shells out via `node:child_process` execFile in two ways:
 *   - `promisify(execFile)` → resolves `{ stdout, stderr }` (text ops)
 *   - the raw callback form inside `execBuffer` → `(err, stdout: Buffer)`
 * We install a single hoisted fake execFile that records every {cmd,args} and
 * answers via canned stdout keyed on the command, so NOTHING real runs.
 */
import type * as ChildProcess from 'node:child_process';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecCall {
  cmd: string;
  args: string[];
}

// Shared fs/promises stub for DarwinBridge.capture (it writes a temp PNG via
// the real `screencapture` and reads it back). We make readFile return a PNG
// buffer that the test sets, so the capture success path runs with no real fs.
const fsState = vi.hoisted(() => ({
  // Set by tests; default forces capture() to fail at readFile.
  fileBuffer: null as Buffer | null,
  rmCalls: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async mkdtemp(prefix: string) {
      return `${prefix}fake`;
    },
    async readFile(...args: unknown[]) {
      if (fsState.fileBuffer) return fsState.fileBuffer;
      // Defer to the real readFile so the missing-file error path is exercised.
      return (actual.readFile as (...a: unknown[]) => Promise<Buffer>)(...args);
    },
    async rm(path: string) {
      fsState.rmCalls.push(path);
    },
  };
});

// Recorded calls + a programmable responder, shared with the hoisted mock.
const h = vi.hoisted(() => {
  // util.promisify.custom is a well-known global symbol; reference it directly
  // so we don't need the util module inside this hoisted (pre-import) block.
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const calls: ExecCall[] = [];
  // Responder returns the stdout (string or Buffer) for a given call, or an
  // Error to simulate failure. Default: empty string.
  let responder: (cmd: string, args: string[]) => string | Buffer | Error = () => '';

  // The fake execFile: supports (cmd, args, cb) and (cmd, args, opts, cb).
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
      err: Error | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => void;
    calls.push({ cmd, args: [...args] });
    const out = responder(cmd, args);
    // Defer like the real async API so promisify/await behave naturally.
    queueMicrotask(() => {
      if (out instanceof Error) cb(out, '', '');
      else cb(null, out, '');
    });
    return undefined as never;
  };
  // The real child_process.execFile carries a custom promisify that resolves
  // `{ stdout, stderr }`; unixBridges.ts relies on that shape. Replicate it so
  // `promisify(execFile)` (used by the bridges) behaves identically.
  (execFile as unknown as Record<symbol, unknown>)[promisifyCustom] = (
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, undefined, (err: Error | null, stdout: string | Buffer) => {
        if (err) reject(err);
        else resolve({ stdout, stderr: '' });
      });
    });

  return {
    calls,
    execFile,
    setResponder(fn: (cmd: string, args: string[]) => string | Buffer | Error) {
      responder = fn;
    },
    reset() {
      calls.length = 0;
      responder = () => '';
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, execFile: h.execFile };
});

// Imported AFTER the mock is registered (vi.mock is hoisted above imports).
import {
  createNativeBridge,
  DarwinBridge,
  LinuxBridge,
  WindowsBridge,
  pngDimensions,
} from '../src/index';

/** Build a minimal-but-valid PNG (8-byte magic + IHDR with width/height). */
function tinyPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // magic
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Find the single recorded call (asserts exactly one was made). */
function onlyCall(): ExecCall {
  expect(h.calls).toHaveLength(1);
  return h.calls[0]!;
}

beforeEach(() => {
  h.reset();
  fsState.fileBuffer = null;
  fsState.rmCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('DarwinBridge command construction', () => {
  let bridge: DarwinBridge;
  beforeEach(() => {
    bridge = new DarwinBridge();
  });

  it('click left → cliclick c:x,y', async () => {
    await bridge.click(10, 20, 'left', 1);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['c:10,20'] });
  });

  it('click right → cliclick rc:x,y', async () => {
    await bridge.click(3, 4, 'right', 1);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['rc:3,4'] });
  });

  it('double click left → cliclick dc:x,y', async () => {
    await bridge.click(5, 6, 'left', 2);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['dc:5,6'] });
  });

  it('moveMouse → cliclick m:x,y', async () => {
    await bridge.moveMouse(100, 200);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['m:100,200'] });
  });

  it('drag → cliclick dd:from du:to', async () => {
    await bridge.drag(1, 2, 3, 4, 'left');
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['dd:1,2', 'du:3,4'] });
  });

  it('typeText → osascript System Events keystroke (JSON-escaped)', async () => {
    await bridge.typeText('he"llo');
    const c = onlyCall();
    expect(c.cmd).toBe('osascript');
    expect(c.args[0]).toBe('-e');
    expect(c.args[1]).toBe('tell application "System Events" to keystroke "he\\"llo"');
  });

  it('keyPress maps named keys to key codes (enter/tab/esc/...)', async () => {
    await bridge.keyPress([
      'enter',
      'tab',
      'escape',
      'space',
      'delete',
      'up',
      'down',
      'left',
      'right',
    ]);
    const codes = h.calls.map((c) => c.args[1]);
    expect(codes).toEqual([
      'tell application "System Events" to key code 36', // enter
      'tell application "System Events" to key code 48', // tab
      'tell application "System Events" to key code 53', // escape
      'tell application "System Events" to key code 49', // space
      'tell application "System Events" to key code 51', // delete
      'tell application "System Events" to key code 126', // up
      'tell application "System Events" to key code 125', // down
      'tell application "System Events" to key code 123', // left
      'tell application "System Events" to key code 124', // right
    ]);
    expect(h.calls.every((c) => c.cmd === 'osascript')).toBe(true);
  });

  it('keyPress falls back to keystroke for ordinary letters', async () => {
    await bridge.keyPress(['a']);
    expect(onlyCall().args[1]).toBe('tell application "System Events" to keystroke "a"');
  });

  it('keyCombo builds a keystroke using {command down}/{shift down}', async () => {
    await bridge.keyCombo(['cmd', 'shift', 'a']);
    expect(onlyCall().args[1]).toBe(
      'tell application "System Events" to keystroke "a" using {command down, shift down}',
    );
  });

  it('keyCombo maps ctrl/alt to control down/option down', async () => {
    await bridge.keyCombo(['ctrl', 'alt', 'x']);
    expect(onlyCall().args[1]).toBe(
      'tell application "System Events" to keystroke "x" using {control down, option down}',
    );
  });

  it('keyCombo with no modifiers emits a bare keystroke per main key', async () => {
    await bridge.keyCombo(['a', 'b']);
    expect(h.calls.map((c) => c.args[1])).toEqual([
      'tell application "System Events" to keystroke "a"',
      'tell application "System Events" to keystroke "b"',
    ]);
  });

  it('scroll up → cliclick w:+amount*5', async () => {
    await bridge.scroll('up', 3);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['w:+15'] });
  });

  it('scroll down → cliclick w:-amount*5', async () => {
    await bridge.scroll('down', 2);
    expect(onlyCall()).toEqual({ cmd: 'cliclick', args: ['w:-10'] });
  });

  it('scroll left/right also use the +/- map', async () => {
    await bridge.scroll('left', 1);
    await bridge.scroll('right', 1);
    expect(h.calls.map((c) => c.args[0])).toEqual(['w:+5', 'w:-5']);
  });

  it('screenSize parses osascript Finder bounds → {width,height}', async () => {
    h.setResponder(() => '0, 0, 2560, 1440');
    const size = await bridge.screenSize();
    expect(size).toEqual({ width: 2560, height: 1440 });
    const c = onlyCall();
    expect(c.cmd).toBe('osascript');
    expect(c.args[1]).toBe('tell application "Finder" to get bounds of window of desktop');
  });

  it('screenSize falls back to 1920x1080 when bounds are unparsable', async () => {
    h.setResponder(() => 'garbage');
    expect(await bridge.screenSize()).toEqual({ width: 1920, height: 1080 });
  });

  it('capture runs screencapture into a temp PNG and returns base64 + dims', async () => {
    const png = tinyPng(2880, 1800);
    fsState.fileBuffer = png; // readFile returns our PNG
    const res = await bridge.capture();
    const screencap = h.calls.find((c) => c.cmd === 'screencapture');
    expect(screencap).toEqual({
      cmd: 'screencapture',
      args: ['-x', '-t', 'png', expect.any(String)],
    });
    expect(res).toMatchObject({ width: 2880, height: 1800 });
    expect(Buffer.from(res.base64, 'base64').equals(png)).toBe(true);
    // The temp dir is cleaned up in the finally block.
    expect(fsState.rmCalls).toHaveLength(1);
  });

  it('capture cleans up the temp dir even when the read fails', async () => {
    // No fileBuffer → readFile hits the real (missing) file and rejects.
    await expect(bridge.capture()).rejects.toBeTruthy();
    expect(fsState.rmCalls).toHaveLength(1); // finally still ran rm
  });

  it('dispose() is a no-op that resolves', async () => {
    await expect(bridge.dispose()).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe('LinuxBridge command construction', () => {
  let bridge: LinuxBridge;
  beforeEach(() => {
    bridge = new LinuxBridge();
  });

  it('click left x2 → xdotool mousemove + click --repeat 2 button 1', async () => {
    await bridge.click(10, 20, 'left', 2);
    expect(onlyCall()).toEqual({
      cmd: 'xdotool',
      args: ['mousemove', '10', '20', 'click', '--repeat', '2', '1'],
    });
  });

  it('click maps right→3 and middle→2', async () => {
    await bridge.click(1, 1, 'right', 1);
    await bridge.click(2, 2, 'middle', 1);
    expect(h.calls[0]!.args.at(-1)).toBe('3');
    expect(h.calls[1]!.args.at(-1)).toBe('2');
  });

  it('moveMouse → xdotool mousemove x y', async () => {
    await bridge.moveMouse(7, 8);
    expect(onlyCall()).toEqual({ cmd: 'xdotool', args: ['mousemove', '7', '8'] });
  });

  it('drag → xdotool mousemove/mousedown/mousemove/mouseup with button', async () => {
    await bridge.drag(1, 2, 3, 4, 'left');
    expect(onlyCall()).toEqual({
      cmd: 'xdotool',
      args: ['mousemove', '1', '2', 'mousedown', '1', 'mousemove', '3', '4', 'mouseup', '1'],
    });
  });

  it('drag uses the requested button on both down and up', async () => {
    await bridge.drag(0, 0, 9, 9, 'right');
    expect(onlyCall().args).toEqual([
      'mousemove',
      '0',
      '0',
      'mousedown',
      '3',
      'mousemove',
      '9',
      '9',
      'mouseup',
      '3',
    ]);
  });

  it('typeText → xdotool type --delay 20 text', async () => {
    await bridge.typeText('hello world');
    expect(onlyCall()).toEqual({ cmd: 'xdotool', args: ['type', '--delay', '20', 'hello world'] });
  });

  it('keyPress maps named keys (Return/Escape/Tab/...) and passes letters through', async () => {
    await bridge.keyPress(['enter', 'esc', 'tab', 'space', 'backspace', 'delete', 'pageup', 'a']);
    expect(h.calls.map((c) => c.args[1])).toEqual([
      'Return',
      'Escape',
      'Tab',
      'space',
      'BackSpace',
      'Delete',
      'Page_Up',
      'a',
    ]);
    expect(h.calls.every((c) => c.cmd === 'xdotool' && c.args[0] === 'key')).toBe(true);
  });

  it('keyCombo → xdotool key ctrl+c style', async () => {
    await bridge.keyCombo(['ctrl', 'c']);
    expect(onlyCall()).toEqual({ cmd: 'xdotool', args: ['key', 'ctrl+c'] });
  });

  it('keyCombo maps win/cmd/meta to super and joins all keys', async () => {
    await bridge.keyCombo(['meta', 'shift', 'x']);
    expect(onlyCall().args[1]).toBe('super+shift+x');
  });

  it('scroll up/down/left/right map to xdotool click buttons 4/5/6/7', async () => {
    await bridge.scroll('up', 1);
    await bridge.scroll('down', 1);
    await bridge.scroll('left', 1);
    await bridge.scroll('right', 1);
    expect(h.calls.map((c) => c.args.at(-1))).toEqual(['4', '5', '6', '7']);
    expect(h.calls.every((c) => c.args.slice(0, 3).join(' ') === 'click --repeat 1')).toBe(true);
  });

  it('scroll with coordinates prepends a mousemove', async () => {
    await bridge.scroll('down', 2, 50, 60);
    expect(onlyCall()).toEqual({
      cmd: 'xdotool',
      args: ['mousemove', '50', '60', 'click', '--repeat', '2', '5'],
    });
  });

  it('screenSize parses xdotool getdisplaygeometry "W H"', async () => {
    h.setResponder(() => '3840 2160');
    expect(await bridge.screenSize()).toEqual({ width: 3840, height: 2160 });
    expect(onlyCall()).toEqual({ cmd: 'xdotool', args: ['getdisplaygeometry'] });
  });

  it('screenSize falls back to height 1080 when geometry is missing', async () => {
    // '' → ['']→ [0]: width parses to 0 (not nullish, so no fallback), but the
    // absent height (undefined) falls back to 1080 via `?? 1080`.
    h.setResponder(() => '');
    expect(await bridge.screenSize()).toEqual({ width: 0, height: 1080 });
  });

  it('screenSize falls back to 1920 width when output is non-numeric', async () => {
    // 'foo bar' → [NaN, NaN]; NaN is not nullish so width stays NaN — assert the
    // single-token case where the missing height triggers the documented 1080.
    h.setResponder(() => 'abc');
    const size = await bridge.screenSize();
    expect(Number.isNaN(size.width)).toBe(true);
    expect(size.height).toBe(1080);
  });

  it('capture returns base64 + parsed dims from a PNG on stdout', async () => {
    const png = tinyPng(640, 480);
    h.setResponder((cmd) => (cmd === 'import' ? png : ''));
    const res = await bridge.capture();
    expect(onlyCall()).toEqual({ cmd: 'import', args: ['-window', 'root', 'png:-'] });
    expect(res).toMatchObject({ width: 640, height: 480 });
    expect(Buffer.from(res.base64, 'base64').equals(png)).toBe(true);
  });

  it('capture rejects when import fails', async () => {
    h.setResponder(() => new Error('import not found'));
    await expect(bridge.capture()).rejects.toThrow(/import not found/);
  });

  it('dispose() is a no-op that resolves', async () => {
    await expect(bridge.dispose()).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe('createNativeBridge platform dispatch', () => {
  it('darwin → DarwinBridge', () => {
    expect(createNativeBridge('darwin')).toBeInstanceOf(DarwinBridge);
  });
  it('linux → LinuxBridge', () => {
    expect(createNativeBridge('linux')).toBeInstanceOf(LinuxBridge);
  });
  it('win32 → WindowsBridge', () => {
    expect(createNativeBridge('win32')).toBeInstanceOf(WindowsBridge);
  });
  it('unknown platform falls back to WindowsBridge (reference impl)', () => {
    expect(createNativeBridge('aix')).toBeInstanceOf(WindowsBridge);
  });
});

describe('pngDimensions extra edge cases', () => {
  it('reads large 32-bit dimensions correctly', () => {
    const png = tinyPng(0x1234, 0x5678);
    expect(pngDimensions(png)).toEqual({ width: 0x1234, height: 0x5678 });
  });
  it('accepts a Uint8Array view with a non-zero byteOffset', () => {
    const png = tinyPng(12, 34);
    const padded = Buffer.concat([Buffer.alloc(8), png]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 8, png.length);
    expect(pngDimensions(view)).toEqual({ width: 12, height: 34 });
  });
});
