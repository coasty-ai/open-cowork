/**
 * Electron main process for the open-cowork desktop shell.
 *
 * Renderer security first: the window hosts the regular web SPA with
 * contextIsolation ON and nodeIntegration OFF; the only native surface the
 * renderer sees is the tiny `window.cowork` API installed by preload.cjs.
 * Local screen control (LocalRunManager + LocalExecutor) lives entirely in
 * this process.
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, screen } from 'electron';
import type { Display } from 'electron';
import { createNativeBridge, LocalExecutor, type ScreenRegion } from '@open-cowork/executor';
import {
  makeProvider,
  mapProviderError,
  type InferenceProvider,
  type ProviderConfig,
} from '@open-cowork/llm';
import { LocalRunManager } from './localRuns';
import { ensureOnScreen, resolveWindowBounds, type DisplayLike } from './windowBounds';
import { loadWindowState, saveWindowState } from './windowState';
import { WindowGuard } from './windowGuard';
import { ProviderStore, parseStoredConfig, type StoredProviderConfig } from './providerStore';

const BACKEND_URL = process.env.COWORK_BACKEND_URL ?? 'http://127.0.0.1:4000';
const WEB_URL = process.env.COWORK_WEB_URL ?? 'http://127.0.0.1:5173';

// Privacy/visibility behaviours: always-on content protection (excluded from
// screen capture), screen-saver-level always-on-top, and a global hotkey that
// fully hides → restores the window for an off-the-record screenshot. The hide
// shortcut is overridable for users whose default clashes.
const HIDE_SHORTCUT = process.env.COWORK_HIDE_SHORTCUT ?? 'CommandOrControl+Shift+H';
const guard = new WindowGuard({
  level: 'screen-saver',
  // A window hidden on a monitor that gets unplugged restores onto a live display.
  clampBounds: (b) => ensureOnScreen(b, currentDisplays(), MIN_SIZE) ?? b,
});

/**
 * The renderer (web SPA) owns the backend session; each `cowork:local-run`
 * IPC call carries the current token, which we hold only for the lifetime of
 * the runs it authorizes. Main never persists credentials of its own.
 */
let sessionToken: string | null = null;

// ── BYO LLM provider config (Coasty stays the default) ───────────────────────
// Non-secret config in userData/provider.json; the API key is encrypted with the
// OS keychain via safeStorage. Resolved lazily (app paths/safeStorage need ready).
let providerFile: string | null = null;
function providerFilePath(): string {
  if (!providerFile) providerFile = path.join(app.getPath('userData'), 'provider.json');
  return providerFile;
}
const providerStore = new ProviderStore({
  read: () => {
    try {
      return readFileSync(providerFilePath(), 'utf8');
    } catch {
      return null;
    }
  },
  write: (data) => {
    mkdirSync(path.dirname(providerFilePath()), { recursive: true });
    writeFileSync(providerFilePath(), data, 'utf8');
  },
  remove: () => {
    try {
      rmSync(providerFilePath());
    } catch {
      /* already gone */
    }
  },
  encrypt: (plain) => {
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(plain).toString('base64')
        : null;
    } catch {
      return null;
    }
  },
  decrypt: (cipherB64) => {
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(cipherB64, 'base64'))
        : null;
    } catch {
      return null;
    }
  },
  secureStorageAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
});

/** Build the provider for a run: the configured BYO provider, else Coasty. */
function buildActiveProvider(): InferenceProvider {
  const stored = providerStore.load();
  if (stored && stored.config.kind !== 'coasty') {
    return makeProvider({ ...stored.config, apiKey: stored.apiKey });
  }
  return makeProvider(
    { kind: 'coasty', model: 'v3' },
    { backendUrl: BACKEND_URL, getToken: () => sessionToken },
  );
}

/** Validate a renderer-supplied config for listModels/health probes (model optional). */
function parseProbeConfig(raw: unknown): ProviderConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const config = parseStoredConfig({
    kind: o.kind,
    model: typeof o.model === 'string' && o.model.trim() ? o.model : 'probe',
    baseUrl: o.baseUrl,
    vision: o.vision,
    visionOverride: o.visionOverride,
    label: o.label,
  });
  if (!config) throw new Error('Invalid provider config');
  return { ...config, apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined };
}

/** Validate a renderer-supplied config to persist (a real BYO provider). */
function parseSetProvider(raw: unknown): { config: StoredProviderConfig; apiKey?: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const config = parseStoredConfig(o);
  if (!config || config.kind === 'coasty') {
    throw new Error('A BYO provider (kind + model) is required; use clear-provider for Coasty.');
  }
  return { config, apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined };
}

const manager = new LocalRunManager({
  backendUrl: BACKEND_URL,
  getToken: () => sessionToken,
  // The region (chosen monitor) reaches the native bridge so the run captures +
  // drives that screen instead of always the primary one.
  createExecutor: (opts) =>
    new LocalExecutor({ bridge: createNativeBridge(process.platform, { region: opts?.region }) }),
  // The active inference provider (Coasty default, or a user-configured BYO LLM),
  // re-read each run so switching providers applies to the next run.
  createProvider: () => buildActiveProvider(),
  machineLabel: os.hostname() || 'local',
});

// The brand icon (Windows/Linux window + taskbar). Bundled CJS lives in dist/,
// so the committed asset is one level up. macOS uses the packaged .icns.
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

// Default + minimum window size. Min keeps the window above the 800px responsive
// breakpoint so the phone/stacked layout can never appear inside a desktop frame.
const DEFAULT_SIZE = { width: 1280, height: 840 };
const MIN_SIZE = { width: 940, height: 640 };

// Where the last window placement is remembered (resolved lazily — app paths are
// only valid once the app is ready).
let stateFile: string | null = null;
function stateFilePath(): string {
  if (!stateFile) stateFile = path.join(app.getPath('userData'), 'window-state.json');
  return stateFile;
}

/** Electron `Display` → the minimal DIP descriptor windowBounds works with. */
function toDisplayLike(d: Display): DisplayLike {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

function currentDisplays(): DisplayLike[] {
  return screen.getAllDisplays().map(toDisplayLike);
}

/** The display the main window currently sits on (for the default screen target). */
function windowDisplayId(): number {
  const [win] = BrowserWindow.getAllWindows();
  const d = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return d.id;
}

/** A friendly label for the screen selector, e.g. "Display 2 · 2560×1440 (primary)". */
function screenLabel(d: Display, index: number, primaryId: number): string {
  const name = d.label && d.label.trim() ? d.label : `Display ${index + 1}`;
  const tag = d.id === primaryId ? ' (primary)' : '';
  return `${name} · ${d.size.width}×${d.size.height}${tag}`;
}

/** The screens the user can target a local run at (renderer populates the selector). */
function listScreens(): { id: number; label: string; primary: boolean; current: boolean }[] {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const currentId = windowDisplayId();
  return displays.map((d, i) => ({
    id: d.id,
    label: screenLabel(d, i, primaryId),
    primary: d.id === primaryId,
    current: d.id === currentId,
  }));
}

/**
 * Resolve a chosen display id to the physical-pixel rect the native bridge
 * captures + drives. Falls back to the window's display, then the primary.
 * `dipToScreenRect` converts Electron's DIP bounds to physical pixels correctly
 * even across mixed-DPI monitors (a plain scaleFactor multiply would not).
 */
function resolveRegion(displayId?: number): ScreenRegion | undefined {
  try {
    const displays = screen.getAllDisplays();
    const display =
      (displayId !== undefined ? displays.find((d) => d.id === displayId) : undefined) ??
      displays.find((d) => d.id === windowDisplayId()) ??
      screen.getPrimaryDisplay();
    const r = screen.dipToScreenRect(null, display.bounds);
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {
    // Fall back to the bridge's default (primary screen) rather than failing.
    return undefined;
  }
}

/**
 * Persist the window's placement so it reopens on the same monitor. We store the
 * *normal* (un-maximized) bounds plus the maximized/fullscreen flags, so a
 * maximized window restores maximized on the correct display rather than its
 * pre-maximize size.
 */
function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const normal = win.getNormalBounds();
  saveWindowState(stateFilePath(), {
    ...normal,
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  });
}

function createWindow(): BrowserWindow {
  // Place the window where it was last closed, on whichever monitor that was —
  // clamped back onto a connected display if that arrangement is gone.
  const saved = loadWindowState(stateFilePath());
  const { bounds } = resolveWindowBounds({
    saved,
    displays: currentDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
  });

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    // Paint the dark canvas immediately so there is no white flash while the SPA
    // initialises.  Matches the --color-bg token (#0a0a0a) in the web design.
    backgroundColor: '#0a0a0a',
    // Hide until the renderer is ready; revealed in the 'ready-to-show' handler
    // below.  Eliminates the flash-of-unstyled-content on startup.
    show: false,
    title: 'Open Co-Work',
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Restore the maximized/fullscreen mode on the monitor the bounds landed on.
  if (saved?.fullScreen) win.setFullScreen(true);
  else if (saved?.maximized) win.maximize();

  // Privacy/visibility: exclude from screen capture + pin always-on-top, and
  // re-assert on show/focus/blur/restore (the OS can drop always-on-top, and a
  // restored window must regain both protections).
  guard.applyProtections(win);
  win.on('show', () => guard.applyProtections(win));
  win.on('focus', () => guard.ensureAlwaysOnTop(win));
  win.on('blur', () => guard.ensureAlwaysOnTop(win));
  win.on('restore', () => guard.ensureAlwaysOnTop(win));

  // Remember placement: a debounced save on move/resize, and a final save on
  // close (covers a maximized/fullscreen window whose normal bounds just changed).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistWindowState(win);
    }, 400);
    if (typeof saveTimer === 'object' && saveTimer && 'unref' in saveTimer) {
      (saveTimer as unknown as { unref(): void }).unref();
    }
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persistWindowState(win);
  });

  // Show the window as soon as the renderer's first paint is complete.
  // 'ready-to-show' fires once, reliably, before the OS repaints — so there is
  // no need for a fallback timer.
  win.once('ready-to-show', () => {
    win.show();
  });

  // E2E loads a built SPA from disk; dev points at the vite dev server.
  const webDist = process.env.COWORK_WEB_DIST;
  if (webDist) {
    const indexHtml = webDist.endsWith('.html') ? webDist : path.join(webDist, 'index.html');
    void win.loadFile(indexHtml);
  } else {
    void win.loadURL(WEB_URL);
  }
  return win;
}

interface StartPayload {
  task: string;
  maxSteps?: number;
  /** Electron display id of the screen to run on (undefined → the window's screen). */
  displayId?: number;
  token: string | null;
}

function parseStartPayload(raw: unknown): StartPayload {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid local-run payload');
  const obj = raw as Record<string, unknown>;
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  if (!task) throw new Error('A non-empty task is required');
  const maxSteps =
    typeof obj.maxSteps === 'number' && Number.isFinite(obj.maxSteps) && obj.maxSteps >= 1
      ? Math.floor(obj.maxSteps)
      : undefined;
  const displayId =
    typeof obj.displayId === 'number' && Number.isFinite(obj.displayId) ? obj.displayId : undefined;
  const token = typeof obj.token === 'string' && obj.token.length > 0 ? obj.token : null;
  return { task, maxSteps, displayId, token };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Synchronous config handshake used by preload before the SPA boots.
  ipcMain.on('cowork:get-config', (event) => {
    event.returnValue = { backendUrl: BACKEND_URL };
  });

  // List the monitors the renderer's screen selector offers for a local run.
  ipcMain.handle('cowork:list-screens', () => listScreens());

  ipcMain.handle('cowork:local-run', async (_event, rawInput: unknown) => {
    const input = parseStartPayload(rawInput);
    sessionToken = input.token;
    return manager.start({
      task: input.task,
      maxSteps: input.maxSteps,
      region: resolveRegion(input.displayId),
    });
  });

  ipcMain.handle('cowork:cancel-local-run', async () => {
    await manager.cancel();
  });

  // ── BYO LLM provider config (secret-free over IPC; key stays in safeStorage) ──
  ipcMain.handle('cowork:get-provider', () => providerStore.status());
  ipcMain.handle('cowork:set-provider', (_event, raw: unknown) => {
    const { config, apiKey } = parseSetProvider(raw);
    providerStore.save(config, apiKey);
    return providerStore.status();
  });
  ipcMain.handle('cowork:clear-provider', () => {
    providerStore.clear();
    return providerStore.status();
  });
  ipcMain.handle('cowork:list-models', async (_event, raw: unknown) => {
    // Capture the key before the risky calls so the catch can scrub it from any
    // error (defense-in-depth; providers also redact internally).
    let apiKey: string | undefined;
    try {
      const config = parseProbeConfig(raw);
      apiKey = config.apiKey;
      const provider = makeProvider(config, {
        backendUrl: BACKEND_URL,
        getToken: () => sessionToken,
      });
      return { ok: true as const, models: await provider.listModels() };
    } catch (err) {
      const e = mapProviderError(err, apiKey);
      return { ok: false as const, code: e.code, message: e.message };
    }
  });
  ipcMain.handle('cowork:test-provider', async (_event, raw: unknown) => {
    let apiKey: string | undefined;
    try {
      const config = parseProbeConfig(raw);
      apiKey = config.apiKey;
      const provider = makeProvider(config, {
        backendUrl: BACKEND_URL,
        getToken: () => sessionToken,
      });
      return await provider.health();
    } catch (err) {
      const e = mapProviderError(err, apiKey);
      return { ok: false, code: e.code, detail: e.message };
    }
  });

  void app.whenReady().then(() => {
    createWindow();

    // Keep every window reachable when the display arrangement changes at
    // runtime (a monitor is unplugged, or resolution/scale/work-area changes):
    // if a window's title bar would be stranded off-screen, pull it back on.
    const reclampAll = () => {
      const displays = currentDisplays();
      for (const win of BrowserWindow.getAllWindows()) {
        // Leave minimized/maximized/fullscreen windows to the OS, which already
        // relocates them to a valid display; only reclamp free-floating windows.
        if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) {
          continue;
        }
        const next = ensureOnScreen(win.getBounds(), displays, MIN_SIZE);
        if (next) win.setBounds(next);
      }
    };
    screen.on('display-removed', reclampAll);
    screen.on('display-added', reclampAll);
    screen.on('display-metrics-changed', reclampAll);

    // Global hotkey to hide → restore the window for an off-the-record
    // screenshot (works even when the window is hidden/unfocused, since it is a
    // system-wide shortcut — that's how the user gets a hidden window back).
    const registered = globalShortcut.register(HIDE_SHORTCUT, () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) guard.toggle(win);
    });
    if (!registered) {
      console.warn(
        `[desktop] could not register hide shortcut "${HIDE_SHORTCUT}" (already in use)`,
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Best-effort: abort an in-flight local run so it is mirrored 'cancelled'.
    void manager.cancel();
    // Never quit with a window left hidden — un-hide it so nothing is stranded.
    const [win] = BrowserWindow.getAllWindows();
    if (win) guard.releaseForQuit(win);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
