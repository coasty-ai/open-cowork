#!/usr/bin/env node
/**
 * Security scan: asserts that no Coasty secret can reach a client.
 *
 * Scans (a) built client bundles and (b) client source trees for:
 *   - Coasty API key values        (sk-coasty-live-..., sk-coasty-test-..., cua_sk_...)
 *   - webhook secret values        (whsec_...)
 *   - the COASTY_API_KEY env name  (its presence in a client bundle means env leakage,
 *     e.g. via a misconfigured bundler `define` / import.meta.env passthrough)
 *
 * Exits non-zero with a file:line report on any hit. Run via `pnpm security:scan`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Directories that must never contain a secret. Built bundles are the real assertion;
 * source trees catch mistakes earlier. Backend is intentionally NOT listed (it is the
 * one legitimate holder of the key — via env, never inline; see SECURITY.md). */
const CLIENT_TARGETS = [
  'apps/web/dist',
  'apps/web/src',
  'apps/desktop/dist',
  'apps/desktop/src',
  'apps/mobile/dist',
  'apps/mobile/src',
  'apps/mobile/App.tsx',
  'packages/ui/src',
  'packages/core/src', // core ships to clients — must hold no secret material
];

const PATTERNS = [
  {
    name: 'Coasty API key value',
    re: /sk-coasty-(?:live|test)-[0-9a-fA-F]{8,}/g,
    allowZeros: true,
  },
  { name: 'Legacy Coasty key value', re: /cua_sk_[0-9a-fA-F]{8,}/g, allowZeros: false },
  { name: 'Webhook secret value', re: /whsec_[0-9a-zA-Z]{8,}/g, allowZeros: false },
  { name: 'COASTY_API_KEY env reference', re: /COASTY_API_KEY/g, allowZeros: false },
];

const SKIP_DIRS = new Set(['node_modules', '.turbo', '.expo', 'coverage']);
const TEXT_EXT = /\.(js|cjs|mjs|ts|tsx|jsx|json|html|css|map|txt)$/;

/** Placeholder keys made of all zeros (as in .env.example) are not secrets. */
function isPlaceholder(match) {
  return /^sk-coasty-(?:live|test)-0+$/.test(match);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.test(entry)) yield p;
  }
}

const findings = [];
let scannedFiles = 0;

for (const target of CLIENT_TARGETS) {
  const abs = join(ROOT, target);
  if (!existsSync(abs)) continue;
  const files = statSync(abs).isDirectory() ? [...walk(abs)] : [abs];
  for (const file of files) {
    scannedFiles++;
    const text = readFileSync(file, 'utf8');
    for (const { name, re, allowZeros } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (allowZeros && isPlaceholder(m[0])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        findings.push({ file: relative(ROOT, file), line, name, match: m[0].slice(0, 24) + '…' });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`✗ SECURITY SCAN FAILED — ${findings.length} potential secret(s) in client code:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.name}]  ${f.match}`);
  process.exit(1);
}
console.log(`✓ security scan clean — ${scannedFiles} client files scanned, no secrets found`);
