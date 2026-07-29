/**
 * The literal zero-config proof: start the bundled mock on the demo default
 * port (4010), build the backend from a COMPLETELY empty environment, and run
 * the full delegate → run → cost-summary flow. This is exactly what a newcomer
 * gets from `pnpm dev` with no .env at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockCoasty, type MockCoasty } from '@open-cowork/mock-coasty';
import { loadConfig, MOCK_BASE_URL } from '../src/config';
import { buildServer, type BuiltServer } from '../src/server';

const DEMO_MOCK_PORT = 4010;

let mock: MockCoasty | null = null;
let built: BuiltServer | null = null;
let backendUrl = '';
let available = false;

beforeAll(async () => {
  mock = createMockCoasty({ tickMs: 5, defaultRunSteps: 3 });
  try {
    await mock.app.listen({ port: DEMO_MOCK_PORT, host: '127.0.0.1' });
    available = true;
  } catch {
    // Port 4010 is busy (a dev mock is already running) — skip cleanly.
    await mock.app.close();
    mock = null;
    return;
  }

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The whole point: NOTHING configured. loadConfig must produce a working
  // demo setup that targets the mock on 4010.
  //
  // COWORK_DB_PATH is the ONE thing pinned, and it is not a cheat: the default
  // (./data/cowork.sqlite) is the DEVELOPER'S REAL DATABASE. A runtime Coasty
  // key persisted there outranks demo mode in resolveBootCredentials AND flips
  // the base URL to live coasty.ai — so on any machine where someone has saved
  // a key through the UI, this "zero-config demo" test silently provisioned
  // REAL, BILLABLE machines against their account. Every other backend test
  // already isolates the database exactly this way.
  const config = loadConfig({ COWORK_DB_PATH: ':memory:' });
  warn.mockRestore();
  expect(config.demoMode).toBe(true);
  expect(config.coastyBaseUrl).toBe(MOCK_BASE_URL);

  built = buildServer({ config });
  // Assert what the Coasty client will ACTUALLY use, not just what loadConfig
  // returned. The two assertions above both passed while the shared client was
  // pointed at live coasty.ai with a billable key, because resolveBootCredentials
  // overrides the config's base URL when it finds a persisted runtime key. This
  // is the assertion that would have caught it.
  expect(built.credentials.source).toBe('demo');
  expect(built.credentials.demoMode).toBe(true);
  expect(built.credentials.baseUrl).toBe(MOCK_BASE_URL);
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  backendUrl = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await built?.app.close();
  await mock?.app.close();
});

describe('zero-config demo bootstrap', () => {
  it('runs a full delegate→run→cost-summary flow with an empty environment', async () => {
    if (!available) {
      // 4010 in use; the unit-level config test already pins demo resolution.
      return;
    }
    // 1. log in (any email) — gets a session token
    const login = (await (
      await fetch(`${backendUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newcomer@example.com' }),
      })
    ).json()) as { token: string };
    expect(login.token).toMatch(/^cwk_/);
    const auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };

    // 2. provision a sandbox machine (instant, free)
    const machine = (await (
      await fetch(`${backendUrl}/api/machines`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ displayName: 'demo-vm', osType: 'linux', confirmCostCents: 5 }),
      })
    ).json()) as { machine: { id: string } };
    expect(machine.machine.id).toMatch(/^mch_test_/);

    // 3. delegate a task with the cost-confirm handshake
    const create = await fetch(`${backendUrl}/api/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        machineId: machine.machine.id,
        task: 'Tidy the downloads folder',
        maxSteps: 10,
        confirmCostCents: 50, // 10 steps × $0.05 worst case
      }),
    });
    expect(create.status).toBe(201);
    const run = (await create.json()) as { id: string };

    // 4. it completes with a cost summary
    const deadline = Date.now() + 8000;
    let final: { status: string; result: { passed?: boolean } | null } | undefined;
    while (Date.now() < deadline) {
      const r = (await (
        await fetch(`${backendUrl}/api/runs/${run.id}`, { headers: auth })
      ).json()) as {
        status: string;
        result: { passed?: boolean } | null;
      };
      if (r.status === 'succeeded') {
        final = r;
        break;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(final?.status).toBe('succeeded');
    expect(final?.result?.passed).toBe(true);
  });
});
