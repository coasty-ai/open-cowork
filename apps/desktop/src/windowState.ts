/**
 * Persisted window placement — a tiny JSON file in the app's userData dir that
 * remembers where the window was last (so it reopens on the same monitor) plus
 * whether it was maximized/fullscreen. Reads are defensive: a missing, corrupt,
 * or partially-written file degrades to "no saved state" (first-launch centring)
 * rather than throwing. Writes are best-effort and never surface errors to the
 * user. The geometry validation here pairs with windowBounds.ts, which clamps
 * whatever survives back onto a currently-connected display.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WindowBox } from './windowBounds';

export interface SavedWindowState extends WindowBox {
  maximized?: boolean;
  fullScreen?: boolean;
}

export function loadWindowState(filePath: string): SavedWindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const { x, y, width, height } = parsed;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return null;
    }
    if ((width as number) <= 0 || (height as number) <= 0) return null;
    return {
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
      maximized: parsed.maximized === true,
      fullScreen: parsed.fullScreen === true,
    };
  } catch {
    return null;
  }
}

export function saveWindowState(filePath: string, state: SavedWindowState): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state), 'utf8');
  } catch {
    // Persistence is best-effort — never crash the app over a failed write.
  }
}
