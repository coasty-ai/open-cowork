#!/usr/bin/env node
/**
 * Electron binary preflight + self-repair.
 *
 *   pnpm fix:electron
 *
 * The `electron` npm package is a ~1 MB stub; the real 100–200 MB runtime is
 * fetched by its own `postinstall` (install.js) and unzipped into the package's
 * `dist/`. That output is invisible to the lockfile, so it can go missing while
 * pnpm still considers the tree fully installed:
 *
 *   - pnpm 10 blocks postinstall scripts unless the package is listed under
 *     `onlyBuiltDependencies` (it is, in pnpm-workspace.yaml) — drop that entry
 *     and electron links but never builds;
 *   - an interrupted/offline install, a pruned store, or a re-link of the
 *     virtual store can leave the package present but unbuilt;
 *   - antivirus, a disk-cleanup tool, or a file-sync client (OneDrive, Dropbox)
 *     can delete `dist/` after the fact — it is a folder of large .exe files.
 *
 * In every case `pnpm install` then says "Already up to date" while `electron .`
 * dies with:
 *
 *   Error: Electron failed to install correctly, please delete
 *   node_modules/electron and try installing again
 *
 * ...because index.js only throws when `path.txt` is absent. Re-running
 * install.js repairs it, and is usually cheap: the downloaded zip is kept in the
 * @electron/get cache, so a repair is just a local unzip.
 *
 * Used by `pnpm desktop` (checks + auto-repairs before booting the stack) and
 * `pnpm run doctor` (reports only). No dependencies; Windows + macOS + Linux.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Executable path *inside* dist/, per platform. Mirrors electron's install.js. */
function platformExecutable(platform = process.env.npm_config_platform || process.platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      return null; // Electron publishes no build for this platform
  }
}

/**
 * Directory of the installed `electron` package, or null when it isn't there.
 * Resolved from apps/desktop because that is the only workspace package that
 * depends on it — with pnpm's isolated node_modules it is deliberately NOT
 * resolvable from the repo root.
 */
export function electronPackageDir() {
  try {
    // `electron/package.json` (not `electron`) so resolution never executes
    // index.js — which throws by design when the binary is missing.
    return dirname(
      createRequire(join(ROOT, 'apps', 'desktop', 'package.json')).resolve('electron/package.json'),
    );
  } catch {
    return null;
  }
}

/**
 * Is the Electron runtime actually on disk, and does it match the package?
 * Returns `{ ok, status, detail, dir, version }` where status is one of
 * 'ok' | 'not-installed' | 'unsupported-platform' | 'missing-binary' | 'version-mismatch'.
 */
export function inspectElectron() {
  const dir = electronPackageDir();
  if (!dir) {
    return {
      ok: false,
      status: 'not-installed',
      detail: 'the `electron` package is not installed — run `pnpm install`',
      dir: null,
      version: null,
    };
  }

  let version = null;
  try {
    version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    /* unreadable package.json — treated as "unknown version" below */
  }

  // npm_config_platform lets a caller cross-target; report whichever platform
  // the decision was actually made for, not just the host's.
  const targetPlatform = process.env.npm_config_platform || process.platform;
  const exe = platformExecutable(targetPlatform);
  if (!exe) {
    return {
      ok: false,
      status: 'unsupported-platform',
      detail: `Electron publishes no build for platform "${targetPlatform}"`,
      dir,
      version,
    };
  }

  // An explicit override means the caller manages the runtime themselves; don't
  // second-guess it, just confirm something is really there.
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override) {
    const target = join(override, exe);
    return existsSync(target)
      ? {
          ok: true,
          status: 'ok',
          detail: `using ELECTRON_OVERRIDE_DIST_PATH (${target})`,
          dir,
          version,
        }
      : {
          ok: false,
          status: 'missing-binary',
          detail: `ELECTRON_OVERRIDE_DIST_PATH is set but ${target} does not exist`,
          dir,
          version,
        };
  }

  // index.js needs path.txt; the launcher needs the executable. Both or bust.
  if (!existsSync(join(dir, 'path.txt')) || !existsSync(join(dir, 'dist', exe))) {
    return {
      ok: false,
      status: 'missing-binary',
      detail: `${join(dir, 'dist', exe)} is missing — electron's postinstall never produced it (or it was deleted)`,
      dir,
      version,
    };
  }

  // A dist/ left behind by a *different* Electron version is just as broken;
  // this is the usual state right after bumping the electron dependency.
  let onDisk = null;
  try {
    onDisk = readFileSync(join(dir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '');
  } catch {
    /* no version file — fall through and trust the executable */
  }
  if (version && onDisk && onDisk !== version) {
    return {
      ok: false,
      status: 'version-mismatch',
      detail: `dist/ holds Electron ${onDisk} but the installed package is ${version}`,
      dir,
      version,
    };
  }

  return {
    ok: true,
    status: 'ok',
    detail: `Electron ${version ?? 'unknown'} binary present`,
    dir,
    version,
  };
}

/** Re-run electron's own postinstall. Cheap when the zip is already cached. */
function runRepair(dir, log) {
  const env = { ...process.env };
  // install.js exits 0 immediately when this is set, which would turn the
  // repair into a silent no-op. Ignore it here (and say so).
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  log("    running electron's postinstall (re-uses the cached download when present)…");
  const r = spawnSync(process.execPath, [join(dir, 'install.js')], {
    cwd: dir,
    env,
    stdio: 'inherit',
  });
  return r.status === 0;
}

function manualSteps(err) {
  err('    Fix it manually, in order:');
  err('      1) pnpm fix:electron            (this script, run on its own)');
  err('      2) pnpm -r rebuild electron     (pnpm re-runs the postinstall)');
  err('      3) pnpm install --force         (re-links + rebuilds the whole tree)');
  err(
    '      4) offline or behind a proxy? set HTTPS_PROXY, or ELECTRON_MIRROR for an internal mirror',
  );
  err('      5) check that `electron` is still listed under onlyBuiltDependencies in');
  err('         pnpm-workspace.yaml — pnpm 10 blocks postinstall scripts without it');
}

/**
 * Verify Electron is runnable, attempting one automatic repair when it is not.
 * Returns true once the binary is ready.
 */
export function ensureElectron({
  repair = true,
  log = (m) => process.stdout.write(`${m}\n`),
  err = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  let state = inspectElectron();
  if (state.ok) return true;

  // Nothing a repair can do about these two.
  if (state.status === 'not-installed' || state.status === 'unsupported-platform') {
    err(`  ✗ Electron unavailable — ${state.detail}`);
    return false;
  }
  if (!repair) {
    err(`  ✗ Electron unavailable — ${state.detail}`);
    manualSteps(err);
    return false;
  }

  err(`  ⚠ Electron is installed but not runnable — ${state.detail}`);
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    log('    note: ELECTRON_SKIP_BINARY_DOWNLOAD is set; ignoring it so the repair can run');
  }

  if (!runRepair(state.dir, log)) {
    err('  ✗ automatic repair failed.');
    manualSteps(err);
    return false;
  }

  state = inspectElectron();
  if (!state.ok) {
    err(`  ✗ still not runnable after the repair — ${state.detail}`);
    manualSteps(err);
    return false;
  }
  log(`  ✓ Electron ${state.version} repaired — continuing`);
  return true;
}

// Standalone: `node scripts/ensure-electron.mjs` / `pnpm fix:electron`.
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const sameFile =
  process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
if (sameFile) {
  const state = inspectElectron();
  // `process.exitCode`, never `process.exit()` — stdout is async when it's a
  // pipe (`pnpm fix:electron`), and exiting outright can swallow the report.
  if (state.ok) {
    console.log(`  ✓ ${state.detail}`);
    process.exitCode = 0;
  } else {
    process.exitCode = ensureElectron() ? 0 : 1;
  }
}
