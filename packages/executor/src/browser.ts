/**
 * BrowserExecutor — drives a Playwright `Page`. Defined against a minimal
 * structural `PageLike` so playwright stays an optional peer dependency and
 * tests can use a fake. With a fixed viewport (e.g. 1280x720) coordinates map
 * 1:1 — the documented no-scaling browser setup.
 */
import { normalizeAction, type CuaAction } from '@open-cowork/core';
import { UnsupportedActionError, type Executor, type Screenshot } from './executor';

/** Structural subset of playwright's Page that we need. */
export interface PageLike {
  screenshot(options?: { type?: 'png' | 'jpeg' }): Promise<Uint8Array>;
  viewportSize(): { width: number; height: number } | null;
  mouse: {
    click(x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>;
    move(x: number, y: number): Promise<void>;
    down(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
    up(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
  };
  waitForTimeout(ms: number): Promise<void>;
}

/** Map CUA key names → Playwright key names. */
const KEY_MAP: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  meta: 'Meta',
};

export function toPlaywrightKey(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  if (key.length === 1) return key;
  // Capitalize unknown multi-char keys (Playwright convention).
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export interface BrowserExecutorOptions {
  page: PageLike;
  /** Default viewport reported when the page has none. */
  fallbackViewport?: { width: number; height: number };
}

export class BrowserExecutor implements Executor {
  readonly kind = 'browser' as const;
  private readonly page: PageLike;
  private readonly fallback: { width: number; height: number };

  constructor(opts: BrowserExecutorOptions) {
    this.page = opts.page;
    this.fallback = opts.fallbackViewport ?? { width: 1280, height: 720 };
  }

  async screenshot(): Promise<Screenshot> {
    const buf = await this.page.screenshot({ type: 'png' });
    const dims = this.page.viewportSize() ?? this.fallback;
    // btoa is unavailable in Node for arbitrary bytes; build base64 manually.
    let binary = '';
    for (const byte of buf) binary += String.fromCharCode(byte);
    const base64 =
      typeof Buffer !== 'undefined' ? Buffer.from(buf).toString('base64') : globalThis.btoa(binary);
    return { base64, width: dims.width, height: dims.height };
  }

  async dimensions(): Promise<{ width: number; height: number }> {
    return this.page.viewportSize() ?? this.fallback;
  }

  async execute(action: CuaAction): Promise<void> {
    const a = normalizeAction(action);
    switch (a.action_type) {
      case 'click':
        await this.page.mouse.click(a.x, a.y, { button: a.button, clickCount: a.clicks });
        return;
      case 'type_text':
        await this.page.keyboard.type(a.text, { delay: 20 });
        return;
      case 'key_press':
        for (const key of a.keys) await this.page.keyboard.press(toPlaywrightKey(key));
        return;
      case 'key_combo':
        await this.page.keyboard.press(a.keys.map(toPlaywrightKey).join('+'));
        return;
      case 'scroll': {
        const delta = a.amount * 120; // wheel "clicks" → pixels, pyautogui-style
        if (a.x !== undefined && a.y !== undefined) await this.page.mouse.move(a.x, a.y);
        switch (a.direction) {
          case 'up':
            await this.page.mouse.wheel(0, -delta);
            return;
          case 'down':
            await this.page.mouse.wheel(0, delta);
            return;
          case 'left':
            await this.page.mouse.wheel(-delta, 0);
            return;
          case 'right':
            await this.page.mouse.wheel(delta, 0);
            return;
        }
        return;
      }
      case 'drag':
        await this.page.mouse.move(a.from_x, a.from_y);
        await this.page.mouse.down({ button: a.button });
        await this.page.mouse.move(a.to_x, a.to_y);
        await this.page.mouse.up({ button: a.button });
        return;
      case 'move':
        await this.page.mouse.move(a.x, a.y);
        return;
      case 'wait':
        await this.page.waitForTimeout(a.ms);
        return;
      case 'done':
      case 'fail':
        return;
      case 'raw':
        // Never execute model-generated code in a browser target (docs say the same).
        throw new UnsupportedActionError('raw', this.kind, 'never exec raw code in a browser target');
      default: {
        const unknown = a as { action_type: string };
        throw new UnsupportedActionError(unknown.action_type, this.kind);
      }
    }
  }

  async dispose(): Promise<void> {
    // The page/browser lifecycle belongs to the caller (Playwright context).
  }
}
