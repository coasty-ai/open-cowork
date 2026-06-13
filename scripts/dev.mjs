#!/usr/bin/env node
/**
 * One-command full-stack dev runner.
 *
 *   pnpm dev            → mock (if needed) + backend + web, all wired together
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
const wantWeb = !process.argv.includes('--no-web');

const procs = [];

function run(name, color, filterArgs) {
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(cmd, filterArgs, { cwd: ROOT, env, shell: isWin });
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

console.log('open-cowork dev stack:');
console.log(
  `  mock Coasty : ${usesMock ? 'YES (demo / local base URL)' : 'no (using your real Coasty key)'}`,
);
console.log(`  backend     : http://127.0.0.1:${env.COWORK_PORT ?? 4000}`);
console.log(`  web         : ${wantWeb ? 'http://127.0.0.1:5173' : 'skipped (--no-web)'}`);
console.log('  (Ctrl+C stops everything)\n');

if (usesMock) run('mock', next(), ['--filter', '@open-cowork/mock-coasty', 'dev']);
run('backend', next(), ['--filter', '@open-cowork/backend', 'dev']);
if (wantWeb) run('web', next(), ['--filter', '@open-cowork/web', 'dev']);
