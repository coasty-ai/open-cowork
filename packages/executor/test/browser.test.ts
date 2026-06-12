import { describe, expect, it } from 'vitest';
import { BrowserExecutor, toPlaywrightKey, type PageLike } from '../src/index';

function fakePage(
  viewport: { width: number; height: number } | null = { width: 1280, height: 720 },
) {
  const calls: string[] = [];
  const page: PageLike = {
    async screenshot() {
      calls.push('screenshot');
      return new TextEncoder().encode('PNGDATA');
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
      async type(text) {
        calls.push(`type(${text})`);
      },
      async press(key) {
        calls.push(`press(${key})`);
      },
    },
    async waitForTimeout(ms) {
      calls.push(`wait(${ms})`);
    },
  };
  return { page, calls };
}

describe('toPlaywrightKey', () => {
  it('maps CUA key names to Playwright names', () => {
    expect(toPlaywrightKey('enter')).toBe('Enter');
    expect(toPlaywrightKey('esc')).toBe('Escape');
    expect(toPlaywrightKey('ctrl')).toBe('Control');
    expect(toPlaywrightKey('cmd')).toBe('Meta');
    expect(toPlaywrightKey('up')).toBe('ArrowUp');
    expect(toPlaywrightKey('f5')).toBe('F5');
    expect(toPlaywrightKey('a')).toBe('a');
    expect(toPlaywrightKey('A')).toBe('A');
  });
});

describe('BrowserExecutor', () => {
  it('screenshot returns base64 with viewport dims (1:1 coordinate space)', async () => {
    const { page } = fakePage();
    const ex = new BrowserExecutor({ page });
    const shot = await ex.screenshot();
    expect(Buffer.from(shot.base64, 'base64').toString()).toBe('PNGDATA');
    expect(shot).toMatchObject({ width: 1280, height: 720 });
  });

  it('falls back to the configured viewport when the page reports none', async () => {
    const { page } = fakePage(null);
    const ex = new BrowserExecutor({ page, fallbackViewport: { width: 800, height: 600 } });
    expect(await ex.dimensions()).toEqual({ width: 800, height: 600 });
  });

  it('executes click/type/keys/scroll/drag/move/wait via the page API', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({ action_type: 'click', params: { x: 5, y: 6, button: 'right', clicks: 2 } });
    await ex.execute({ action_type: 'type_text', params: { text: 'hi' } });
    await ex.execute({ action_type: 'key_press', params: { keys: ['tab', 'enter'] } });
    await ex.execute({ action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } });
    await ex.execute({ action_type: 'scroll', params: { direction: 'down', amount: 2 } });
    await ex.execute({ action_type: 'scroll', params: { clicks: 3 } }); // pyautogui variant → up
    await ex.execute({ action_type: 'drag', params: { x1: 1, y1: 2, x2: 3, y2: 4 } });
    await ex.execute({ action_type: 'move', params: { x: 9, y: 9 } });
    await ex.execute({ action_type: 'wait', params: { seconds: 1 } });
    expect(calls).toEqual([
      'click(5,6,right,2)',
      'type(hi)',
      'press(Tab)',
      'press(Enter)',
      'press(Control+c)',
      'wheel(0,240)',
      'wheel(0,-360)',
      'move(1,2)',
      'down(left)',
      'move(3,4)',
      'up(left)',
      'move(9,9)',
      'wait(1000)',
    ]);
  });

  it('scroll with coordinates moves the mouse first', async () => {
    const { page, calls } = fakePage();
    const ex = new BrowserExecutor({ page });
    await ex.execute({
      action_type: 'scroll',
      params: { x: 10, y: 20, direction: 'left', amount: 1 },
    });
    expect(calls).toEqual(['move(10,20)', 'wheel(-120,0)']);
  });

  it('refuses raw code in a browser target', async () => {
    const { page } = fakePage();
    const ex = new BrowserExecutor({ page });
    await expect(ex.execute({ action_type: 'raw', params: { code: 'alert(1)' } })).rejects.toThrow(
      /never exec raw code/,
    );
  });
});
