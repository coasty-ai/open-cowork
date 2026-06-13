#!/usr/bin/env node
/**
 * Real entrypoint smoke for the one-key / zero-config promise.
 *
 * Spawns the ACTUAL backend entrypoint (apps/backend/src/main.ts via tsx) and
 * the ACTUAL mock CLI — the same code `pnpm dev` runs — with NO Coasty key in
 * the environment (demo mode), then drives the full
 *   login → provision → delegate → run → cost-summary
 * flow over real HTTP. Picks free ports so it never collides with a running
 * dev stack or the Playwright suite. Exits 0 on success, 1 on failure.
 *
 *   pnpm --filter @open-cowork/e2e smoke:bootstrap
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function start(name, args, env) {
  const child = spawn(pnpm, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: isWin });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}

async function main() {
  const mockPort = await freePort();
  const backendPort = await freePort();
  const base = `http://127.0.0.1:${backendPort}`;

  // Mock on a free port.
  start('mock', ['--filter', '@open-cowork/mock-coasty', 'start'], { PORT: String(mockPort) });
  await waitFor(`http://127.0.0.1:${mockPort}/health`);

  // Backend in DEMO MODE: empty key shadows any repo .env, base URL points at
  // our mock, no session secret (auto-generated). This is the zero-config path.
  start('backend', ['--filter', '@open-cowork/backend', 'start'], {
    COASTY_API_KEY: '',
    COASTY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    COWORK_PORT: String(backendPort),
    COWORK_PUBLIC_URL: base,
    COWORK_DB_PATH: ':memory:',
    COWORK_SESSION_SECRET: '',
  });
  await waitFor(`${base}/health`);

  const j = async (res) => {
    if (!res.ok) throw new Error(`${res.url} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const post = (path, body, token) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (path, token) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  const { token } = await j(await post('/api/auth/login', { email: 'smoke@example.com' }));
  if (!token) throw new Error('login returned no token');

  const machine = await j(
    await post(
      '/api/machines',
      { displayName: 'smoke-vm', osType: 'linux', confirmCostCents: 5 },
      token,
    ),
  );
  const machineId = machine.machine.id;
  if (!String(machineId).startsWith('mch_test_'))
    throw new Error(`expected sandbox machine, got ${machineId}`);

  const run = await j(
    await post(
      '/api/runs',
      { machineId, task: 'Smoke: tidy the desktop', maxSteps: 10, confirmCostCents: 50 },
      token,
    ),
  );

  const deadline = Date.now() + 15000;
  let status = run.status;
  while (Date.now() < deadline && status !== 'succeeded') {
    await new Promise((r) => setTimeout(r, 100));
    status = (await j(await get(`/api/runs/${run.id}`, token))).status;
  }
  if (status !== 'succeeded') throw new Error(`run did not succeed (last status: ${status})`);

  console.log('\n✓ zero-config entrypoint smoke passed: login → machine → run → succeeded');
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((err) => {
    console.error('\n✗ bootstrap smoke FAILED:', err.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
