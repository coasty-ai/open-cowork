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
import { spawn, execSync } from 'node:child_process';
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
// Mirror tools/mock-coasty/src/cli.ts: PORT ?? MOCK_PORT ?? 4010.
const mockPort = (env.PORT ?? env.MOCK_PORT ?? '4010').toString().trim() || '4010';
const WEB_PORT = '5173'; // apps/web/vite.config: strictPort, so a stale holder is fatal
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
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

/**
 * PIDs holding a LISTEN socket on `port` (our own pid excluded). Returns [] if
 * nothing is listening or the lookup tool is unavailable — never throws.
 */
function listenersOnPort(port) {
  const mine = String(process.pid);
  try {
    if (isWin) {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
      const tail = new RegExp(`:${port}$`); // local address ends with :PORT (incl. [::1]:PORT)
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (!/\bLISTENING\b/i.test(line)) continue; // ignore client/ESTABLISHED/TIME_WAIT rows
        const parts = line.trim().split(/\s+/);
        const local = parts[1] ?? '';
        const pid = parts[parts.length - 1] ?? '';
        if (tail.test(local) && /^\d+$/.test(pid) && pid !== '0' && pid !== mine) pids.add(pid);
      }
      return [...pids];
    }
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' });
    return [...new Set(out.split(/\s+/).filter((p) => p && p !== mine))];
  } catch {
    return []; // nothing listening, or netstat/lsof missing
  }
}

/** Force-kill a PID (and its child tree on Windows). Best-effort; never throws. */
function killPid(pid) {
  try {
    if (isWin) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
    else process.kill(Number(pid), 'SIGKILL');
  } catch {
    /* already gone or not permitted */
  }
}

/**
 * Free the ports this stack is about to bind, so a stale process from a previous
 * run (e.g. a vite/backend that didn't shut down) can't fail the launch — the
 * web dev server uses strictPort, so a held :5173 is otherwise fatal. Only the
 * LISTENER on each port is killed; we then wait until it's actually released.
 */
async function freePorts(specs) {
  for (const { port, label } of specs) {
    let pids = listenersOnPort(port);
    if (pids.length === 0) continue;
    process.stdout.write(`  freeing :${port} (${label}) — stopping stale PID ${pids.join(', ')}\n`);
    for (const pid of pids) killPid(pid);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      pids = listenersOnPort(port);
      if (pids.length === 0) break;
      await new Promise((res) => setTimeout(res, 150));
    }
    if (pids.length)
      process.stdout.write(`  ⚠ :${port} still in use after kill — starting anyway\n`);
  }
}

console.log('open-cowork dev stack:');
console.log(
  `  mock Coasty : ${usesMock ? 'YES (demo / local base URL)' : 'no (using your real Coasty key)'}`,
);
console.log(`  backend     : ${BACKEND_URL}`);
console.log(`  web         : ${wantWeb ? WEB_URL : 'skipped (--no-web)'}`);
if (wantDesktop)
  console.log(
    '  desktop     : Electron (local screen control) — launches when web + backend are up',
  );
console.log('  (Ctrl+C stops everything)\n');

// Loud guardrail: a real key means runs/machines hit your REAL Coasty account
// and bill real credits. Easy to set once in .env and forget — so say so.
if (!usesMock) {
  const Y = '\x1b[33m';
  console.log(
    `${Y}  ⚠  LIVE Coasty key — runs & machines will hit your REAL account and BILL credits.${RESET}`,
  );
  console.log(
    `${Y}     Errors like "RUN_CREATE_FAILED" then come from Coasty (machine state, credits, …).${RESET}`,
  );
  console.log(
    `${Y}     For free local dev: unset COASTY_API_KEY in .env (demo mode → bundled mock), or set${RESET}`,
  );
  console.log(
    `${Y}     COASTY_BASE_URL=http://127.0.0.1:4010/v1 to point your key at the mock.${RESET}\n`,
  );
}

void (async () => {
  // Reclaim the ports we're about to bind so a leftover process from a previous
  // run starts cleanly instead of failing (web's strictPort makes a held :5173
  // fatal). Only ports this run will actually use are touched.
  const ports = [{ port: backendPort, label: 'backend' }];
  if (wantWeb) ports.push({ port: WEB_PORT, label: 'web' });
  if (usesMock) ports.push({ port: mockPort, label: 'mock' });
  await freePorts(ports);
  if (shuttingDown) return;

  if (usesMock) run('mock', next(), ['--filter', '@open-cowork/mock-coasty', 'dev']);
  run('backend', next(), ['--filter', '@open-cowork/backend', 'dev']);
  if (wantWeb) run('web', next(), ['--filter', '@open-cowork/web', 'dev']);

  if (wantDesktop) {
    process.stdout.write('\n[desktop] waiting for backend + web to be ready…\n');
    const ok = (await waitForHttp(`${BACKEND_URL}/health`)) && (await waitForHttp(WEB_URL));
    if (shuttingDown) return;
    if (!ok) {
      process.stderr.write(
        '[desktop] backend/web did not come up — not launching the desktop app.\n',
      );
      shutdown(1);
      return;
    }
    process.stdout.write(
      '[desktop] launching the Electron window… (close it to stop everything)\n',
    );
    run('desktop', next(), ['--filter', '@open-cowork/desktop', 'dev'], {
      COWORK_WEB_URL: WEB_URL,
      COWORK_BACKEND_URL: BACKEND_URL,
      // Some IDE/extension hosts set this; with it, `electron .` runs as plain
      // Node and never opens a window. Strip it for the desktop child.
      ELECTRON_RUN_AS_NODE: undefined,
    });
  }
})();
