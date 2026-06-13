/**
 * Preload — the ONLY bridge between the sandboxed renderer (the shared web
 * SPA) and the Electron main process. Exposes the minimal `window.cowork`
 * surface the SPA already knows from apps/web/src/api/client.ts.
 */
import { contextBridge, ipcRenderer } from 'electron';

const config = ipcRenderer.sendSync('cowork:get-config') as { backendUrl: string };

/**
 * Session-token custody: the web SPA holds the backend session token in
 * localStorage under 'cowork-session' (zustand `persist` envelope:
 * `{"state":{"token":"...","user":{...}},"version":0}`). The preload script
 * runs in the same renderer origin, so it can read that storage directly and
 * attach the token to each local-run IPC request. Main therefore only ever
 * sees the token the signed-in SPA session already owns — it stores no
 * credentials itself and a logged-out renderer cannot start local runs.
 */
function readSessionToken(): string | null {
  try {
    const raw = window.localStorage.getItem('cowork-session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: unknown } };
    return typeof parsed.state?.token === 'string' && parsed.state.token.length > 0
      ? parsed.state.token
      : null;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('cowork', {
  platform: 'desktop' as const,
  backendUrl: config.backendUrl,
  startLocalRun: (input: {
    task: string;
    maxSteps?: number;
    /** Electron display id of the screen to run on (from `listScreens`). */
    displayId?: number;
  }): Promise<{ runId: string }> =>
    ipcRenderer.invoke('cowork:local-run', { ...input, token: readSessionToken() }) as Promise<{
      runId: string;
    }>,
  cancelLocalRun: (): Promise<void> =>
    ipcRenderer.invoke('cowork:cancel-local-run') as Promise<void>,
  /** The monitors a local run can target (for the screen selector). */
  listScreens: (): Promise<{ id: number; label: string; primary: boolean; current: boolean }[]> =>
    ipcRenderer.invoke('cowork:list-screens') as Promise<
      { id: number; label: string; primary: boolean; current: boolean }[]
    >,
});
