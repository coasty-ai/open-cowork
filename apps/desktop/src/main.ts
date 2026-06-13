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
import { existsSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { Display } from 'electron';
import { createNativeBridge, LocalExecutor } from '@open-cowork/executor';
import { LocalRunManager } from './localRuns';
import { ensureOnScreen, resolveWindowBounds, type DisplayLike } from './windowBounds';
import { loadWindowState, saveWindowState } from './windowState';

const BACKEND_URL = process.env.COWORK_BACKEND_URL ?? 'http://127.0.0.1:4000';
const WEB_URL = process.env.COWORK_WEB_URL ?? 'http://127.0.0.1:5173';

/**
 * The renderer (web SPA) owns the backend session; each `cowork:local-run`
 * IPC call carries the current token, which we hold only for the lifetime of
 * the runs it authorizes. Main never persists credentials of its own.
 */
let sessionToken: string | null = null;

const manager = new LocalRunManager({
  backendUrl: BACKEND_URL,
  getToken: () => sessionToken,
  createExecutor: () => new LocalExecutor({ bridge: createNativeBridge(process.platform) }),
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
  const token = typeof obj.token === 'string' && obj.token.length > 0 ? obj.token : null;
  return { task, maxSteps, token };
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

  ipcMain.handle('cowork:local-run', async (_event, rawInput: unknown) => {
    const input = parseStartPayload(rawInput);
    sessionToken = input.token;
    return manager.start({ task: input.task, maxSteps: input.maxSteps });
  });

  ipcMain.handle('cowork:cancel-local-run', async () => {
    await manager.cancel();
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
  });
}
