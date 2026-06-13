#!/usr/bin/env node
/**
 * One-command full-stack dev runner.
 *
 *   pnpm desktop        → mock (if needed) + backend + web, then the DESKTOP app
 *                         (Electron, local screen control) — starts everything,
 *                         waits until it's ready, launches the window, and stops
 *                         it all when you close the window.
 *   pnpm dev            → mock (if needed) + backend + web (open the web app)
 *   pnpm dev --no-web   → just the API stack (mock + backend)
 *
 * The ONLY thing you might set is COASTY_API_KEY in .env:
 *   - set it          → backend talks to the real Coasty API; the mock is NOT started
 *   - leave it unset  → DEMO MODE: backend uses a sandbox key against the bundled
 *                       mock, which this script starts for you. Zero spend.
 *
 * No dependencies; works on Windows + macOS + Linux.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[32m', '\x1b[33m']; // cyan, magenta, green, yellow
const RESET = '\x1b[0m';

/** Load .env into a plain object (does not mutate process.env globally). */
function readDotenv() {
  const file = join(ROOT, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...readDotenv(), ...process.env };
const hasKey = Boolean((env.COASTY_API_KEY ?? '').trim());
const baseUrl = (env.COASTY_BASE_URL ?? '').trim();
const usesMock =
  env.COWORK_USE_MOCK === '1' ||
  !hasKey ||
  baseUrl.includes('4010') ||
  baseUrl.includes('localhost:4010');
const wantDesktop = process.argv.includes('--desktop');
// The desktop shell hosts the web UI, so web is always on in desktop mode.
const wantWeb = wantDesktop || !process.argv.includes('--no-web');
const backendPort = (env.COWORK_PORT ?? '4000').toString().trim() || '4000';
const WEB_URL = 'http://127.0.0.1:5173';
const BACKEND_URL = `http://127.0.0.1:${backendPort}`;

const procs = [];

function run(name, color, filterArgs, extraEnv = {}) {
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm';
  // Merge extra env; a value of `undefined` removes the key from the child env.
  const childEnv = { ...env, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete childEnv[k];
  const child = spawn(cmd, filterArgs, { cwd: ROOT, env: childEnv, shell: isWin });
  const prefix = `${color}[${name}]${RESET} `;
  const pipe = (stream, target) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (code ${code ?? 0})\n`);
    if (!shuttingDown) shutdown(code ?? 0);
  });
  procs.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

let i = 0;
const next = () => COLORS[i++ % COLORS.length];

/** Poll a URL until it responds (any status) or we time out / shut down. */
async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      await fetch(url);
      return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

console.log('open-cowork dev stack:');
console.log(
  `  mock Coasty : ${usesMock ? 'YES (demo / local base URL)' : 'no (using your real Coasty key)'}`,
);
console.log(`  backend     : ${BACKEND_URL}`);
console.log(`  web         : ${wantWeb ? WEB_URL : 'skipped (--no-web)'}`);
if (wantDesktop) console.log('  desktop     : Electron (local screen control) — launches when web + backend are up');
console.log('  (Ctrl+C stops everything)\n');

if (usesMock) run('mock', next(), ['--filter', '@open-cowork/mock-coasty', 'dev']);
run('backend', next(), ['--filter', '@open-cowork/backend', 'dev']);
if (wantWeb) run('web', next(), ['--filter', '@open-cowork/web', 'dev']);

if (wantDesktop) {
  void (async () => {
    process.stdout.write('\n[desktop] waiting for backend + web to be ready…\n');
    const ok = (await waitForHttp(`${BACKEND_URL}/health`)) && (await waitForHttp(WEB_URL));
    if (shuttingDown) return;
    if (!ok) {
      process.stderr.write('[desktop] backend/web did not come up — not launching the desktop app.\n');
      shutdown(1);
      return;
    }
    process.stdout.write('[desktop] launching the Electron window… (close it to stop everything)\n');
    run('desktop', next(), ['--filter', '@open-cowork/desktop', 'dev'], {
      COWORK_WEB_URL: WEB_URL,
      COWORK_BACKEND_URL: BACKEND_URL,
      // Some IDE/extension hosts set this; with it, `electron .` runs as plain
      // Node and never opens a window. Strip it for the desktop child.
      ELECTRON_RUN_AS_NODE: undefined,
    });
  })();
}
