/**
 * Build smoke test: `node build.mjs` must produce both Electron bundles.
 * Keeps `pnpm --filter @open-cowork/desktop build` honest without spawning
 * Electron itself.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

describe('build.mjs', () => {
  it('bundles src/main.ts and src/preload.ts into dist/*.cjs', async () => {
    await run(process.execPath, ['build.mjs'], { cwd: appDir });

    const mainPath = path.join(appDir, 'dist', 'main.cjs');
    const preloadPath = path.join(appDir, 'dist', 'preload.cjs');
    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(preloadPath)).toBe(true);
    // Bundled (core + executor inlined), not just transpiled stubs.
    expect(statSync(mainPath).size).toBeGreaterThan(10_000);
    expect(statSync(preloadPath).size).toBeGreaterThan(500);

    // electron stays external; workspace packages are inlined.
    const main = readFileSync(mainPath, 'utf8');
    expect(main).toContain('require("electron")');
    expect(main).not.toContain('require("@open-cowork/core")');
    expect(main).not.toContain('require("@open-cowork/executor")');
    const preload = readFileSync(preloadPath, 'utf8');
    expect(preload).toContain('cowork:get-config');
  }, 120_000);
});
