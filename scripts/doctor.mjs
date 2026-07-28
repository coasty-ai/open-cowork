#!/usr/bin/env node
/**
 * Preflight check: confirms the machine + config are ready to run open-cowork
 * with nothing but (optionally) a Coasty key. Prints a clear, actionable
 * report and exits non-zero if anything would block `pnpm dev`.
 *
 *   pnpm run doctor
 *
 * The `run` is required: `doctor` is also a built-in pnpm command, and bare
 * `pnpm doctor` runs pnpm's own checker instead of this script (silently — it
 * exits 0 and prints nothing but a config warning).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inspectElectron } from './ensure-electron.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const BAD = '\x1b[31m✗\x1b[0m';

let blocking = 0;
const line = (mark, msg) => console.log(`  ${mark} ${msg}`);

console.log('open-cowork doctor\n');

// Node version
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major > 22 || (major === 22 && minor >= 5)) {
  line(OK, `Node ${process.versions.node} (≥ 22.5 — node:sqlite available)`);
} else {
  line(BAD, `Node ${process.versions.node} is too old; need ≥ 22.5 for node:sqlite`);
  blocking++;
}

// node:sqlite present
try {
  await import('node:sqlite');
  line(OK, 'node:sqlite import works');
} catch {
  line(BAD, 'node:sqlite is unavailable in this Node build');
  blocking++;
}

// .env / key
const envFile = join(ROOT, '.env');
const env = {};
if (existsSync(envFile)) {
  for (const l of readFileSync(envFile, 'utf8').split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}
const key = (env.COASTY_API_KEY ?? process.env.COASTY_API_KEY ?? '').trim();
const keyRe = /^(sk-coasty-(live|test)-[0-9a-fA-F]{8,}|cua_sk_[0-9a-fA-F]{8,})$/;
if (!key) {
  line(WARN, 'No COASTY_API_KEY set → DEMO MODE (mock Coasty, zero spend). `pnpm dev` just works.');
} else if (!keyRe.test(key)) {
  line(BAD, 'COASTY_API_KEY is set but malformed (expected sk-coasty-live/test-* or cua_sk_*)');
  blocking++;
} else if (key.startsWith('sk-coasty-test-')) {
  line(OK, 'COASTY_API_KEY is a SANDBOX key (never bills) → talks to real Coasty');
} else {
  line(WARN, 'COASTY_API_KEY is a LIVE key → real spend possible. Estimates + caps are enforced.');
}

// secrets in .env are fine; warn only if they accidentally appear elsewhere is handled by security:scan
if (!env.COWORK_SESSION_SECRET) {
  line(
    OK,
    'No COWORK_SESSION_SECRET (auto-generated at boot — set one in production for durable sessions)',
  );
}

// node_modules installed
if (existsSync(join(ROOT, 'node_modules', '.pnpm'))) {
  line(OK, 'Dependencies installed');
} else {
  line(BAD, 'Dependencies not installed — run `pnpm install`');
  blocking++;
}

// Electron's binary is fetched by a postinstall and lives outside the lockfile,
// so it can be missing while pnpm reports "Already up to date". Only `pnpm
// desktop` needs it, so this warns rather than blocks.
const electron = inspectElectron();
if (electron.ok) {
  line(OK, `${electron.detail} — \`pnpm desktop\` can launch`);
} else if (electron.status === 'unsupported-platform') {
  line(WARN, `${electron.detail} — \`pnpm desktop\` is unavailable here; \`pnpm dev\` still works`);
} else {
  line(
    WARN,
    `Electron not runnable (${electron.detail}) — run \`pnpm fix:electron\`; \`pnpm dev\` still works`,
  );
}

console.log('');
if (blocking === 0) {
  console.log('Ready. Run `pnpm dev` to start everything (Ctrl+C stops it).');
} else {
  console.log(`${blocking} blocking issue(s) above. Fix them, then re-run \`pnpm run doctor\`.`);
}
// Set the code and let Node exit naturally. `process.exit()` can tear the
// process down before stdout drains, since writes to a pipe (as opposed to a
// TTY) are asynchronous — which would truncate the report above.
process.exitCode = blocking === 0 ? 0 : 1;
