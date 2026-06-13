/**
 * Desktop E2E (Electron): the shell boots, exposes the local-control bridge,
 * and the SPA detects the desktop platform — the "This computer" target shows
 * up with its local-control warning. We deliberately do NOT start a local run
 * here: it would take over the real mouse/keyboard of whatever machine runs
 * the suite. The LocalRunManager loop is covered by desktop unit tests, and
 * the native capture path by the executor's opt-in smoke test.
 */
import { resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

declare global {
  interface Window {
    cowork?: {
      platform: 'desktop' | 'web';
      backendUrl?: string;
      startLocalRun?: (input: { task: string; maxSteps?: number }) => Promise<{ runId: string }>;
      cancelLocalRun?: () => Promise<void>;
    };
  }
}

const DESKTOP_DIR = resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');

test('desktop shell boots, exposes window.cowork, and offers the local target', async () => {
  // Strip ELECTRON_RUN_AS_NODE (set by IDE extension hosts): with it present,
  // electron.exe boots as plain Node and rejects Playwright's debug flags.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
    ),
  ) as Record<string, string>;

  const app = await electron.launch({
    args: [DESKTOP_DIR],
    cwd: DESKTOP_DIR,
    env: {
      ...env,
      COWORK_WEB_URL: 'http://127.0.0.1:4173',
      COWORK_BACKEND_URL: 'http://127.0.0.1:4000',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Electron persists localStorage across launches; a token left by a prior
    // run would skip the login screen. Start each run from a clean session.
    // (The app also auto-logs-out on a 401, so a stale token can't strand it.)
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Preload bridge is present and renderer-safe (contextIsolation on).
    const bridge = await page.evaluate(() => ({
      platform: window.cowork?.platform,
      hasStart: typeof window.cowork?.startLocalRun === 'function',
      hasCancel: typeof window.cowork?.cancelLocalRun === 'function',
      nodeLeak: typeof (window as unknown as { require?: unknown }).require,
    }));
    expect(bridge.platform).toBe('desktop');
    expect(bridge.hasStart).toBe(true);
    expect(bridge.hasCancel).toBe(true);
    expect(bridge.nodeLeak).toBe('undefined'); // no Node in the renderer

    // Always-on-top is pinned on launch (queried in the real main process).
    const onTopAtLaunch = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? win.isAlwaysOnTop() : null;
    });
    expect(onTopAtLaunch).toBe(true);

    // …and re-asserted when the OS drops it: force it off, fire the real 'focus'
    // handler, and confirm the guard pinned it back. (Exercises the actual
    // main-process wiring; content protection has no getter, so it's manual.)
    const reasserted = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return null;
      win.setAlwaysOnTop(false);
      (win as unknown as { emit(event: string): void }).emit('focus');
      return win.isAlwaysOnTop();
    });
    expect(reasserted).toBe(true);

    // Sign in inside the desktop shell.
    await page.getByLabel(/email/i).fill(`desktop-${Date.now()}@example.com`);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /delegate a task/i })).toBeVisible();

    // The local screen target is first-class on desktop.
    const machineSelect = page.getByRole('combobox');
    await expect(machineSelect.locator('option', { hasText: /this computer/i })).toHaveCount(1);

    // Selecting it and submitting surfaces the local-control warning in the
    // confirm dialog — then we cancel instead of starting (real input safety).
    await page.getByLabel(/task/i).fill('organize my downloads folder');
    await machineSelect.selectOption({ label: 'This computer (local screen)' });
    await page.getByRole('button', { name: /delegate|run task|start|submit/i }).click();
    const confirm = page.getByRole('dialog', { name: /confirm cost/i });
    await expect(confirm).toContainText(/your own mouse and keyboard/i);
    await confirm.getByRole('button', { name: /^cancel$/i }).click();
    await expect(confirm).toBeHidden();
  } finally {
    await app.close();
  }
});
