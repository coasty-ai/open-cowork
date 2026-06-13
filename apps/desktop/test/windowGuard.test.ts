import { describe, expect, it } from 'vitest';
import { WindowGuard, type AlwaysOnTopLevel, type GuardWindow } from '../src/windowGuard';
import type { WindowBox } from '../src/windowBounds';

/**
 * A stateful fake BrowserWindow: every operation mutates tracked state the way
 * Electron would, so a hide→restore round-trip can be asserted to return the
 * window to its exact prior state. `throwOn` forces a method to throw (fail-safe
 * tests); call counts back the "re-asserted" assertions.
 */
class FakeWindow implements GuardWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  maximized = false;
  fullScreen = false;
  focused = true;
  alwaysOnTop = false;
  alwaysOnTopLevel: AlwaysOnTopLevel | undefined;
  contentProtection = false;
  bounds: WindowBox = { x: 100, y: 100, width: 1280, height: 840 };
  calls: Record<string, number> = {};
  throwOn = new Set<string>();

  constructor(init: Partial<FakeWindow> = {}) {
    Object.assign(this, init);
  }

  private hit(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.throwOn.has(name)) throw new Error(`boom: ${name}`);
  }

  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  isFocused() {
    return this.focused;
  }
  isAlwaysOnTop() {
    return this.alwaysOnTop;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(b: WindowBox) {
    this.hit('setBounds');
    this.bounds = { ...b };
  }
  setAlwaysOnTop(flag: boolean, level?: AlwaysOnTopLevel) {
    this.hit('setAlwaysOnTop');
    this.alwaysOnTop = flag;
    this.alwaysOnTopLevel = level;
  }
  setContentProtection(enable: boolean) {
    this.hit('setContentProtection');
    this.contentProtection = enable;
  }
  show() {
    this.hit('show');
    this.visible = true;
    this.minimized = false;
    this.focused = true;
  }
  showInactive() {
    this.hit('showInactive');
    this.visible = true;
    this.minimized = false;
  }
  hide() {
    this.hit('hide');
    this.visible = false;
    this.focused = false;
  }
  focus() {
    this.hit('focus');
    this.focused = true;
  }
  minimize() {
    this.hit('minimize');
    this.minimized = true;
    this.focused = false;
  }
  restore() {
    this.hit('restore');
    this.minimized = false;
  }
  maximize() {
    this.hit('maximize');
    this.maximized = true;
  }
  unmaximize() {
    this.hit('unmaximize');
    this.maximized = false;
  }
  setFullScreen(flag: boolean) {
    this.hit('setFullScreen');
    this.fullScreen = flag;
  }
}

/** Snapshot the user-visible state for an exact before/after comparison. */
function snapshot(w: FakeWindow) {
  return {
    visible: w.visible,
    minimized: w.minimized,
    maximized: w.maximized,
    fullScreen: w.fullScreen,
    focused: w.focused,
    bounds: { ...w.bounds },
  };
}

describe('WindowGuard — launch protections', () => {
  it('enables content protection and pins always-on-top at the screen-saver level', () => {
    const win = new FakeWindow({ alwaysOnTop: false });
    new WindowGuard({ level: 'screen-saver' }).applyProtections(win);
    expect(win.contentProtection).toBe(true);
    expect(win.alwaysOnTop).toBe(true);
    expect(win.alwaysOnTopLevel).toBe('screen-saver');
  });

  it('is a no-op on a destroyed window', () => {
    const win = new FakeWindow({ destroyed: true });
    new WindowGuard().applyProtections(win);
    expect(win.contentProtection).toBe(false);
    expect(win.calls.setAlwaysOnTop).toBeUndefined();
  });
});

describe('WindowGuard — always-on-top re-assertion', () => {
  it('re-asserts always-on-top when the OS dropped it (focus/blur/show)', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ alwaysOnTop: true });
    guard.ensureAlwaysOnTop(win);
    expect(win.calls.setAlwaysOnTop ?? 0).toBe(0); // already on → no-op

    win.alwaysOnTop = false; // OS dropped it after a focus change
    guard.ensureAlwaysOnTop(win);
    expect(win.alwaysOnTop).toBe(true);
    expect(win.calls.setAlwaysOnTop).toBe(1);
  });

  it('uses the configured floating level when asked', () => {
    const win = new FakeWindow({ alwaysOnTop: false });
    new WindowGuard({ level: 'floating' }).ensureAlwaysOnTop(win);
    expect(win.alwaysOnTopLevel).toBe('floating');
  });
});

describe('WindowGuard — hide → restore returns to the exact prior state', () => {
  it('round-trips a focused, normal window byte-for-byte', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ focused: true, alwaysOnTop: true });
    const before = snapshot(win);

    guard.hide(win);
    expect(guard.hidden).toBe(true);
    expect(win.visible).toBe(false);

    guard.restore(win);
    expect(guard.hidden).toBe(false);
    expect(snapshot(win)).toEqual(before);
  });

  it('restores to the moved position (snapshot captured where it was)', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ bounds: { x: 2200, y: 300, width: 1100, height: 800 } });
    guard.hide(win);
    guard.restore(win);
    expect(win.bounds).toEqual({ x: 2200, y: 300, width: 1100, height: 800 });
  });

  it('restores a not-focused window WITHOUT stealing focus', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ focused: false });
    guard.hide(win);
    guard.restore(win);
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(false);
    expect(win.calls.showInactive).toBe(1);
    expect(win.calls.focus ?? 0).toBe(0);
  });

  it('restores a maximized window to maximized (not its inner bounds)', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ maximized: true });
    guard.hide(win);
    guard.restore(win);
    expect(win.maximized).toBe(true);
    expect(win.calls.maximize).toBe(1);
    expect(win.calls.setBounds ?? 0).toBe(0);
  });

  it('restores a fullscreen window to fullscreen', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ fullScreen: true });
    guard.hide(win);
    guard.restore(win);
    expect(win.fullScreen).toBe(true);
    expect(win.calls.setFullScreen).toBe(1);
  });

  it('trigger while MINIMIZED restores back to minimized', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ minimized: true, focused: false });
    const before = snapshot(win);
    guard.hide(win);
    guard.restore(win);
    expect(win.minimized).toBe(true);
    expect(snapshot(win)).toEqual(before);
  });

  it('clamps restored bounds onto a live display (monitor unplugged while hidden)', () => {
    // Simulate a clamp that pulls an off-screen x back onto the primary display.
    const clampBounds = (b: WindowBox): WindowBox => (b.x > 1920 ? { ...b, x: 320 } : b);
    const guard = new WindowGuard({ clampBounds });
    const win = new FakeWindow({ bounds: { x: 2400, y: 200, width: 1100, height: 800 } });
    guard.hide(win);
    guard.restore(win);
    expect(win.bounds.x).toBe(320); // clamped back on-screen
  });

  it('re-asserts always-on-top after restoring (show can drop it)', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ alwaysOnTop: true });
    guard.hide(win);
    win.alwaysOnTop = false; // dropped while hidden / by show
    guard.restore(win);
    expect(win.alwaysOnTop).toBe(true);
  });
});

describe('WindowGuard — toggle + rapid/edge triggers', () => {
  it('toggle hides then restores', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    const before = snapshot(win);
    guard.toggle(win);
    expect(win.visible).toBe(false);
    guard.toggle(win);
    expect(snapshot(win)).toEqual(before);
  });

  it('rapid repeated hide is idempotent — the original snapshot survives', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ bounds: { x: 100, y: 100, width: 1280, height: 840 } });
    guard.hide(win);
    // The window can't move while hidden, but if state were poked, a second hide
    // must NOT overwrite the snapshot.
    win.bounds = { x: 5, y: 5, width: 400, height: 300 };
    guard.hide(win);
    expect(win.calls.hide).toBe(1); // second hide was a no-op
    guard.restore(win);
    expect(win.bounds).toEqual({ x: 100, y: 100, width: 1280, height: 840 });
  });

  it('rapid toggle×4 ends visible and consistent', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.toggle(win); // hide
    guard.toggle(win); // show
    guard.toggle(win); // hide
    guard.toggle(win); // show
    expect(guard.hidden).toBe(false);
    expect(win.visible).toBe(true);
  });

  it('restore with nothing hidden is a no-op', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.restore(win);
    expect(win.calls.show ?? 0).toBe(0);
    expect(win.calls.showInactive ?? 0).toBe(0);
  });
});

describe('WindowGuard — fail-safe (never stuck invisible)', () => {
  it('a throwing hide() leaves the window visible and not hidden', () => {
    const guard = new WindowGuard();
    // hide() increments its counter then throws, without flipping visibility.
    const win = new FakeWindow({ throwOn: new Set(['hide']) });
    guard.hide(win);
    expect(guard.hidden).toBe(false);
    expect(win.visible).toBe(true);
  });

  it('a throwing restore still leaves the window visible', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.hide(win);
    win.throwOn.add('setBounds'); // restore will throw mid-way (after show)
    guard.restore(win);
    expect(win.visible).toBe(true);
    expect(guard.hidden).toBe(false);
  });
});

describe('WindowGuard — destroyed window + quit safety', () => {
  it('hide/restore/toggle on a destroyed window never throw', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow({ destroyed: true });
    expect(() => guard.hide(win)).not.toThrow();
    expect(() => guard.restore(win)).not.toThrow();
    expect(() => guard.toggle(win)).not.toThrow();
    expect(guard.hidden).toBe(false);
  });

  it('clears hidden state if the window is destroyed while hidden', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.hide(win);
    win.destroyed = true;
    guard.restore(win); // window gone — just clear, don't operate
    expect(guard.hidden).toBe(false);
  });

  it('releaseForQuit un-hides a hidden window so no ghost is left behind', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.hide(win);
    expect(win.visible).toBe(false);
    guard.releaseForQuit(win);
    expect(win.visible).toBe(true);
    expect(guard.hidden).toBe(false);
  });

  it('releaseForQuit is a no-op when nothing is hidden', () => {
    const guard = new WindowGuard();
    const win = new FakeWindow();
    guard.releaseForQuit(win);
    expect(win.calls.show ?? 0).toBe(0);
  });
});
