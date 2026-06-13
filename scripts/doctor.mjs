#!/usr/bin/env node
/**
 * Preflight check: confirms the machine + config are ready to run open-cowork
 * with nothing but (optionally) a Coasty key. Prints a clear, actionable
 * report and exits non-zero if anything would block `pnpm dev`.
 *
 *   pnpm doctor
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

console.log('');
if (blocking === 0) {
  console.log('Ready. Run `pnpm dev` to start everything (Ctrl+C stops it).');
  process.exit(0);
} else {
  console.log(`${blocking} blocking issue(s) above. Fix them, then re-run \`pnpm doctor\`.`);
  process.exit(1);
}
