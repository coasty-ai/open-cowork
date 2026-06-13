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
import { app, BrowserWindow, ipcMain } from 'electron';
import { createNativeBridge, LocalExecutor } from '@open-cowork/executor';
import { LocalRunManager } from './localRuns';

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    // Keep the window above the 800px responsive breakpoint so the phone/stacked
    // layout can never appear inside a desktop frame.
    minWidth: 940,
    minHeight: 640,
    // Paint the dark canvas immediately so there is no white flash while the SPA
    // initialises.  Matches the --color-bg token (#0a0a0a) in the web design.
    backgroundColor: '#0a0a0a',
    // Hide until the renderer is ready; revealed in the 'ready-to-show' handler
    // below.  Eliminates the flash-of-unstyled-content on startup.
    show: false,
    title: 'open-cowork',
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
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
