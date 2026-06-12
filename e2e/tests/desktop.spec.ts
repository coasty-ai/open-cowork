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
  const app = await electron.launch({
    args: ['.'],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      COWORK_WEB_URL: 'http://127.0.0.1:4173',
      COWORK_BACKEND_URL: 'http://127.0.0.1:4000',
    },
  });
  try {
    const page = await app.firstWindow();
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
