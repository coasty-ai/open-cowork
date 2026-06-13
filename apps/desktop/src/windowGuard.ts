/**
 * WindowGuard — the two privacy/visibility behaviours of the desktop shell,
 * implemented as pure state logic over a structural window interface so they are
 * exhaustively unit-testable without Electron (the real `BrowserWindow`
 * satisfies {@link GuardWindow} structurally).
 *
 *  1. Hidden from screen capture. Always-on content protection
 *     (`setContentProtection(true)`) excludes the window from screenshots and
 *     recordings while it stays visible to the user — automatic, no flicker, on
 *     Windows & macOS. A global hotkey additionally toggles a full hide→restore
 *     (the only reliable option on Linux, where content protection is a no-op):
 *     the exact prior state — bounds, maximized/fullscreen/minimized, focus,
 *     visibility — is snapshotted on hide and re-applied on restore.
 *
 *  2. Always-on-top while running, at the `screen-saver` level so it survives
 *     focus changes and other apps going fullscreen (where the OS allows). The
 *     OS occasionally drops the flag on focus/blur/show, so it is re-asserted on
 *     those events.
 *
 * Fail-safe is the rule: any error on the hide path leaves the window VISIBLE,
 * never stuck invisible, and a destroyed window is always a no-op.
 */
import type { WindowBox } from './windowBounds';

/** Always-on-top stacking levels we use (a subset of Electron's). */
export type AlwaysOnTopLevel = 'normal' | 'floating' | 'screen-saver';

/**
 * The window operations the guard needs. Electron's `BrowserWindow` implements
 * all of these, so it can be passed directly; tests pass a fake.
 */
export interface GuardWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isFocused(): boolean;
  isAlwaysOnTop(): boolean;
  getBounds(): WindowBox;
  setBounds(bounds: WindowBox): void;
  setAlwaysOnTop(flag: boolean, level?: AlwaysOnTopLevel): void;
  setContentProtection(enable: boolean): void;
  show(): void;
  showInactive(): void;
  hide(): void;
  focus(): void;
  minimize(): void;
  restore(): void;
  maximize(): void;
  unmaximize(): void;
  setFullScreen(flag: boolean): void;
}

/** The exact window state captured at hide time, re-applied verbatim on restore. */
interface StealthSnapshot {
  bounds: WindowBox;
  minimized: boolean;
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

export interface WindowGuardOptions {
  /** Always-on-top level (default `screen-saver`). */
  level?: AlwaysOnTopLevel;
  /**
   * Clamp restored bounds onto a currently-connected display. Lets a window
   * hidden on a monitor that was unplugged meanwhile come back on-screen rather
   * than restoring to now-invisible coordinates. Defaults to identity.
   */
  clampBounds?: (bounds: WindowBox) => WindowBox;
}

export class WindowGuard {
  private readonly level: AlwaysOnTopLevel;
  private readonly clampBounds: (bounds: WindowBox) => WindowBox;
  private snapshot: StealthSnapshot | null = null;

  constructor(opts: WindowGuardOptions = {}) {
    this.level = opts.level ?? 'screen-saver';
    this.clampBounds = opts.clampBounds ?? ((b) => b);
  }

  /** True while the window is hidden by {@link hide}. */
  get hidden(): boolean {
    return this.snapshot !== null;
  }

  /**
   * Apply the always-on launch protections: exclude from screen capture and
   * pin always-on-top. Safe to call repeatedly (e.g. on every `show`).
   */
  applyProtections(win: GuardWindow): void {
    if (win.isDestroyed()) return;
    win.setContentProtection(true);
    this.ensureAlwaysOnTop(win);
  }

  /** Re-assert always-on-top if the OS dropped it (call on focus/blur/show). */
  ensureAlwaysOnTop(win: GuardWindow): void {
    if (win.isDestroyed()) return;
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, this.level);
  }

  /**
   * Hide the window for an off-the-record screenshot, snapshotting its exact
   * state first. Idempotent (a second hide while already hidden is a no-op, so
   * rapid repeated triggers can't lose the original snapshot). Fail-safe: if the
   * hide throws, the window is left visible and NOT marked hidden.
   */
  hide(win: GuardWindow): void {
    if (win.isDestroyed() || this.hidden) return;
    const snap: StealthSnapshot = {
      bounds: win.getBounds(),
      minimized: win.isMinimized(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      focused: win.isFocused(),
    };
    try {
      win.hide();
      this.snapshot = snap;
    } catch {
      this.snapshot = null;
      this.ensureVisible(win);
    }
  }

  /**
   * Restore the window to the exact state captured by {@link hide}: visibility,
   * geometry (clamped onto a live display), maximized/fullscreen/minimized mode,
   * and focus. No-op if not hidden. Fail-safe: any error still leaves the window
   * visible.
   */
  restore(win: GuardWindow): void {
    if (win.isDestroyed()) {
      this.snapshot = null;
      return;
    }
    const s = this.snapshot;
    if (!s) return;
    // Clear first so a throwing restore can never loop or strand the flag.
    this.snapshot = null;
    try {
      // Re-show, taking focus only if it had focus before.
      if (s.focused) win.show();
      else win.showInactive();

      if (s.fullScreen) {
        win.setFullScreen(true);
      } else if (s.maximized) {
        win.maximize();
      } else {
        if (win.isMaximized()) win.unmaximize();
        win.setBounds(this.clampBounds(s.bounds));
      }

      if (s.minimized) win.minimize();
      else if (s.focused) win.focus();

      // `show` can drop the always-on-top flag on some platforms.
      this.ensureAlwaysOnTop(win);
    } catch {
      this.ensureVisible(win);
    }
  }

  /** Toggle: hide if visible, restore if hidden. The global-hotkey entry point. */
  toggle(win: GuardWindow): void {
    if (this.hidden) this.restore(win);
    else this.hide(win);
  }

  /**
   * Called on app quit: if the window is hidden, bring it back so quitting can
   * never leave a hidden-but-alive ghost window. Safe on a destroyed window.
   */
  releaseForQuit(win: GuardWindow): void {
    if (win.isDestroyed()) {
      this.snapshot = null;
      return;
    }
    if (this.hidden) this.restore(win);
  }

  /** Last-resort: make sure the window is on screen; swallow any failure. */
  private ensureVisible(win: GuardWindow): void {
    try {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    } catch {
      // Nothing more we can safely do.
    }
  }
}
