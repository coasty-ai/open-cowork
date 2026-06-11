/**
 * Best-effort macOS and Linux NativeBridge implementations (see DECISIONS.md
 * D2). They shell out to common OS tools per call:
 *  - macOS: `screencapture` (built-in) + `cliclick` (brew) with `osascript`
 *    fallbacks for typing/keys. Requires Screen Recording + Accessibility
 *    permissions for the host app.
 *  - Linux (X11): `import` (ImageMagick) or `gnome-screenshot` + `xdotool`.
 * Marked experimental: Windows is the reference implementation; these are
 * structured identically so they can be hardened on real hardware.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CaptureResult, MouseButton, NativeBridge, ScrollDirection } from './bridge';
import { WindowsBridge } from './windowsBridge';

const exec = promisify(execFile);

/** execFile capturing stdout as a Buffer (for binary output like PNG). */
function execBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Minimal PNG header parse to recover width/height without dependencies. */
export function pngDimensions(buf: Uint8Array): { width: number; height: number } {
  // PNG: 8-byte magic, then IHDR chunk: 4 len + 'IHDR' + 4 width + 4 height
  if (buf.length < 24) throw new Error('Not a PNG (too short)');
  const magicOk =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!magicOk) throw new Error('Not a PNG (bad magic)');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

abstract class ShellBridge implements NativeBridge {
  abstract capture(): Promise<CaptureResult>;
  abstract screenSize(): Promise<{ width: number; height: number }>;
  abstract click(x: number, y: number, button: MouseButton, clicks: number): Promise<void>;
  abstract moveMouse(x: number, y: number): Promise<void>;
  abstract drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void>;
  abstract typeText(text: string): Promise<void>;
  abstract keyPress(keys: string[]): Promise<void>;
  abstract keyCombo(keys: string[]): Promise<void>;
  abstract scroll(direction: ScrollDirection, amount: number, x?: number, y?: number): Promise<void>;
  async dispose(): Promise<void> {
    // exec-per-call: nothing persistent to release
  }
}

export class DarwinBridge extends ShellBridge {
  async capture(): Promise<CaptureResult> {
    const dir = await mkdtemp(join(tmpdir(), 'cowork-cap-'));
    const file = join(dir, 'screen.png');
    try {
      await exec('screencapture', ['-x', '-t', 'png', file]);
      const buf = await readFile(file);
      const dims = pngDimensions(buf);
      return { base64: buf.toString('base64'), ...dims };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const { stdout } = await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
    const parts = stdout.trim().split(',').map((s) => Number(s.trim()));
    return { width: parts[2] ?? 1920, height: parts[3] ?? 1080 };
  }

  async click(x: number, y: number, button: MouseButton, clicks: number): Promise<void> {
    const cmd = button === 'right' ? 'rc' : clicks >= 2 ? 'dc' : 'c';
    await exec('cliclick', [`${cmd}:${x},${y}`]);
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await exec('cliclick', [`m:${x},${y}`]);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, _button: MouseButton): Promise<void> {
    await exec('cliclick', [`dd:${fromX},${fromY}`, `du:${toX},${toY}`]);
  }

  async typeText(text: string): Promise<void> {
    await exec('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
  }

  async keyPress(keys: string[]): Promise<void> {
    const KEYCODES: Record<string, number> = {
      enter: 36, return: 36, tab: 48, esc: 53, escape: 53, space: 49,
      delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124,
    };
    for (const key of keys) {
      const code = KEYCODES[key.toLowerCase()];
      if (code !== undefined) {
        await exec('osascript', ['-e', `tell application "System Events" to key code ${code}`]);
      } else {
        await exec('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(key)}`]);
      }
    }
  }

  async keyCombo(keys: string[]): Promise<void> {
    const MODS: Record<string, string> = {
      cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down',
      ctrl: 'control down', control: 'control down',
      alt: 'option down', option: 'option down',
      shift: 'shift down',
    };
    const mods = keys.filter((k) => MODS[k.toLowerCase()]).map((k) => MODS[k.toLowerCase()]!);
    const mains = keys.filter((k) => !MODS[k.toLowerCase()]);
    const using = mods.length > 0 ? ` using {${mods.join(', ')}}` : '';
    for (const main of mains) {
      await exec('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(main)}${using}`]);
    }
  }

  async scroll(direction: ScrollDirection, amount: number, _x?: number, _y?: number): Promise<void> {
    const map: Record<ScrollDirection, string> = { up: '+', down: '-', left: '+', right: '-' };
    const axis = direction === 'left' || direction === 'right' ? 'h' : 'v';
    void axis;
    await exec('cliclick', [`w:${map[direction]}${amount * 5}`]);
  }
}

export class LinuxBridge extends ShellBridge {
  async capture(): Promise<CaptureResult> {
    // ImageMagick `import` writes PNG to stdout with `png:-`.
    const stdout = await execBuffer('import', ['-window', 'root', 'png:-']);
    const dims = pngDimensions(stdout);
    return { base64: stdout.toString('base64'), ...dims };
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const { stdout } = await exec('xdotool', ['getdisplaygeometry']);
    const [w, h] = stdout.trim().split(/\s+/).map(Number);
    return { width: w ?? 1920, height: h ?? 1080 };
  }

  private static BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

  async click(x: number, y: number, button: MouseButton, clicks: number): Promise<void> {
    await exec('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(clicks), LinuxBridge.BUTTONS[button]]);
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await exec('xdotool', ['mousemove', String(x), String(y)]);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void> {
    const b = LinuxBridge.BUTTONS[button];
    await exec('xdotool', ['mousemove', String(fromX), String(fromY), 'mousedown', b, 'mousemove', String(toX), String(toY), 'mouseup', b]);
  }

  async typeText(text: string): Promise<void> {
    await exec('xdotool', ['type', '--delay', '20', text]);
  }

  async keyPress(keys: string[]): Promise<void> {
    const MAP: Record<string, string> = {
      enter: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
      backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
      home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
    };
    for (const key of keys) {
      await exec('xdotool', ['key', MAP[key.toLowerCase()] ?? key]);
    }
  }

  async keyCombo(keys: string[]): Promise<void> {
    const MAP: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', cmd: 'super', meta: 'super' };
    const combo = keys.map((k) => MAP[k.toLowerCase()] ?? k).join('+');
    await exec('xdotool', ['key', combo]);
  }

  async scroll(direction: ScrollDirection, amount: number, x?: number, y?: number): Promise<void> {
    const BUTTON: Record<ScrollDirection, string> = { up: '4', down: '5', left: '6', right: '7' };
    const args: string[] = [];
    if (x !== undefined && y !== undefined) args.push('mousemove', String(x), String(y));
    args.push('click', '--repeat', String(amount), BUTTON[direction]);
    await exec('xdotool', args);
  }
}

/** Pick the bridge for the current platform (Windows is the reference impl). */
export function createNativeBridge(platform: NodeJS.Platform = process.platform): NativeBridge {
  if (platform === 'darwin') return new DarwinBridge();
  if (platform === 'linux') return new LinuxBridge();
  return new WindowsBridge();
}
