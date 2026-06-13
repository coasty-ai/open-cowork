import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWindowState, saveWindowState, type SavedWindowState } from '../src/windowState';

const tmpDirs: string[] = [];
function tmpFile(name = 'window-state.json'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oc-winstate-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('windowState persistence', () => {
  it('round-trips a saved state', () => {
    const file = tmpFile();
    const state: SavedWindowState = {
      x: -1200,
      y: 80,
      width: 1300,
      height: 860,
      maximized: false,
      fullScreen: false,
    };
    saveWindowState(file, state);
    expect(loadWindowState(file)).toEqual(state);
  });

  it('persists the maximized / fullScreen flags', () => {
    const file = tmpFile();
    saveWindowState(file, { x: 0, y: 0, width: 1280, height: 840, maximized: true });
    const loaded = loadWindowState(file);
    expect(loaded?.maximized).toBe(true);
    expect(loaded?.fullScreen).toBe(false);
  });

  it('returns null for a missing file', () => {
    expect(loadWindowState(tmpFile('does-not-exist.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const file = tmpFile();
    writeFileSync(file, '{ not json', 'utf8');
    expect(loadWindowState(file)).toBeNull();
  });

  it('returns null when geometry fields are missing or non-finite', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ x: 0, y: 0, width: 'wide', height: 840 }), 'utf8');
    expect(loadWindowState(file)).toBeNull();
  });

  it('returns null for non-positive dimensions', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ x: 0, y: 0, width: 0, height: 840 }), 'utf8');
    expect(loadWindowState(file)).toBeNull();
  });

  it('creates the parent directory on save', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oc-winstate-'));
    tmpDirs.push(dir);
    const nested = path.join(dir, 'a', 'b', 'window-state.json');
    saveWindowState(nested, { x: 1, y: 2, width: 1000, height: 700 });
    expect(loadWindowState(nested)).toMatchObject({ x: 1, y: 2, width: 1000, height: 700 });
  });
});
