/**
 * The wallet/usage preflight must be BEST-EFFORT.
 *
 * The Coasty `usage` scope is NOT granted on a default key, so `coasty.usage()`
 * can return 403 INSUFFICIENT_SCOPE. The preflight used to `await` it
 * unguarded, so a 403 there aborted run + machine creation entirely (surfacing
 * as a generic upstream error like "Could not create run."). These tests build
 * the real server against a Coasty that 403s on /usage but accepts everything
 * else, and assert that create operations still succeed — and that the
 * preflight still enforces a 402 when usage IS available and the wallet is dry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltServer } from '../src/server';

const LIVE_KEY = `sk-coasty-live-${'b'.repeat(48)}`;

type UsageMode = 'forbidden' | 'dry' | 'funded';

function coastyFetch(usageMode: UsageMode): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.endsWith('/usage')) {
      if (usageMode === 'forbidden') {
        return json(
          {
            error: {
              code: 'INSUFFICIENT_SCOPE',
              message: "Key lacks the 'usage' scope",
              type: 'auth_error',
              request_id: 'req_scope',
              required_scope: 'usage',
            },
          },
          403,
        );
      }
      const balance = usageMode === 'dry' ? 2 : 100000;
      return json({
        period: '2026-06',
        total_requests: 0,
        total_credits: 0,
        total_cost_cents: 0,
        breakdown: {},
        balance,
        wallet_balance_cents: balance,
        wallet_balance_usd: balance / 100,
      });
    }
    if (url.includes('/workflows/runs') && method === 'POST') {
      return json({
        id: 'wfr_1',
        object: 'workflow.run',
        status: 'queued',
        workflow_id: null,
        workflow_version: null,
        machine_id: null,
        inputs: {},
        output: null,
        error: null,
        awaiting_human_reason: null,
        awaiting_step_id: null,
        iterations_used: 0,
        spent_cents: 0,
        budget_cents: 100,
        webhook_url: null,
        webhook_secret: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        request_id: 'req_w',
      });
    }
    if (url.endsWith('/v1/runs') && method === 'POST') {
      return json({
        id: 'run_1',
        object: 'agent.run',
        status: 'queued',
        machine_id: 'm',
        task: 't',
        cua_version: 'v3',
        instructions: null,
        max_steps: 25,
        on_awaiting_human: 'pause',
        steps_completed: 0,
        credits_charged: 0,
        cost_cents: 0,
        result: null,
        error: null,
        awaiting_human_reason: null,
        metadata: null,
        webhook_url: null,
        webhook_secret: null,
        created_at: new Date().toISOString(),
        started_at: null,
        awaiting_human_since: null,
        finished_at: null,
        request_id: 'req_r',
      });
    }
    if (url.endsWith('/v1/machines') && method === 'POST') {
      return json(
        {
          machine: {
            id: 'mch_live_1',
            display_name: 'vm',
            status: 'creating',
            os_type: 'linux',
            provider: 'aws',
            desktop_enabled: true,
            cpu_cores: 2,
            memory_gb: 4,
            storage_gb: 20,
            public_ip: null,
            is_test: false,
            created_at: new Date().toISOString(),
            metadata: {},
          },
          connection: {
            public_ip: null,
            ssh_port: 22,
            ssh_username: 'ubuntu',
            vnc_port: 5900,
            websocket_port: 8080,
            has_ssh_key: true,
            has_vnc_password: true,
          },
          request_id: 'req_m',
        },
        201,
      );
    }
    // Event streams (Ingestor) + everything else: 404, swallowed by the ingestor.
    return json(
      { error: { code: 'NOT_FOUND', message: 'n/a', type: 'not_found_error', request_id: 'r' } },
      404,
    );
  }) as unknown as typeof fetch;
}

let built: BuiltServer | null = null;
let base = '';

async function start(usageMode: UsageMode): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const config = loadConfig({
    COASTY_API_KEY: LIVE_KEY,
    COWORK_PUBLIC_URL: 'http://127.0.0.1:4000',
    COWORK_DB_PATH: ':memory:',
    COWORK_SESSION_SECRET: 'preflight-test-secret-32-characters',
  });
  warn.mockRestore();
  built = buildServer({ config, fetchImpl: coastyFetch(usageMode) });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
}

async function authed() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'preflight@example.com' }),
  });
  const { token } = (await res.json()) as { token: string };
  return (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
}

afterEach(async () => {
  await built?.app.close();
  built = null;
  base = '';
});

describe('best-effort wallet preflight (usage scope is not on a default key)', () => {
  it('run creation SUCCEEDS even when usage() 403s (the "Could not create run." bug)', async () => {
    await start('forbidden');
    const post = await authed();
    const res = await post('/api/runs', {
      machineId: 'm',
      task: 'go',
      maxSteps: 25,
      confirmCostCents: 125,
    });
    expect(res.status).toBe(201);
  });

  it('machine provisioning SUCCEEDS even when usage() 403s', async () => {
    await start('forbidden');
    const post = await authed();
    const res = await post('/api/machines', {
      displayName: 'vm',
      osType: 'linux',
      confirmCostCents: 5,
    });
    expect(res.status).toBe(201);
  });

  it('workflow run creation SUCCEEDS even when usage() 403s', async () => {
    await start('forbidden');
    const post = await authed();
    const res = await post('/api/workflows/runs', {
      budgetCents: 100,
      confirmCostCents: 100,
      definition: { steps: [{ id: 't', type: 'task', task: 'go' }] },
    });
    expect(res.status).toBe(201);
  });

  it('GET /api/wallet degrades gracefully when usage() 403s (walletAvailable:false + reason)', async () => {
    await start('forbidden');
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'w@example.com' }),
    });
    const { token } = (await res.json()) as { token: string };
    const wallet = (await (
      await fetch(`${base}/api/wallet`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as {
      walletAvailable: boolean;
      balanceCents: number | null;
      walletUnavailableReason?: string;
      monthSpendCents: number;
    };
    expect(wallet.walletAvailable).toBe(false);
    expect(wallet.balanceCents).toBeNull();
    expect(wallet.walletUnavailableReason).toMatch(/usage/i);
    expect(wallet.monthSpendCents).toBe(0); // local data still works
  });

  it('STILL enforces a real 402 when usage IS available and the wallet is dry', async () => {
    await start('dry');
    const post = await authed();
    const res = await post('/api/runs', {
      machineId: 'm',
      task: 'go',
      maxSteps: 25,
      confirmCostCents: 125,
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_CREDITS',
    );
  });

  it('creates the run normally when the wallet is funded', async () => {
    await start('funded');
    const post = await authed();
    const res = await post('/api/runs', {
      machineId: 'm',
      task: 'go',
      maxSteps: 25,
      confirmCostCents: 125,
    });
    expect(res.status).toBe(201);
  });
});
