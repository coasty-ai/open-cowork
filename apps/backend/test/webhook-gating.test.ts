/**
 * Regression for the "every run 422s against real Coasty" bug.
 *
 * Coasty requires HTTPS webhook URLs. The backend used to always send
 * `${COWORK_PUBLIC_URL}/webhooks/coasty` — http by default — so the real API
 * rejected run/workflow creation with a validation error. These tests build
 * the real server against a non-local upstream (via an injected fetch spy that
 * captures the exact outbound Coasty request body) and assert the gating:
 *   - non-https public URL  → webhook_url omitted (null), run still created
 *   - https public URL      → webhook_url registered
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltServer } from '../src/server';

const LIVE_KEY = `sk-coasty-live-${'b'.repeat(48)}`;

interface Captured {
  runBody?: Record<string, unknown>;
  workflowRunBody?: Record<string, unknown>;
}

/** A fetch that emulates a non-local Coasty endpoint just enough for the
 * create-run/create-workflow-run flow, recording the request bodies. */
function coastySpy(captured: Captured): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.endsWith('/usage')) {
      return json({
        period: '2026-06',
        total_requests: 0,
        total_credits: 0,
        total_cost_cents: 0,
        breakdown: {},
        balance: 100000,
        wallet_balance_cents: 100000,
        wallet_balance_usd: 1000,
      });
    }
    if (url.includes('/workflows/runs') && method === 'POST') {
      captured.workflowRunBody = JSON.parse(String(init?.body ?? '{}'));
      return json({
        id: 'wfr_live1',
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
        webhook_url: captured.workflowRunBody?.webhook_url ?? null,
        webhook_secret: captured.workflowRunBody?.webhook_url ? 'whsec_live' : null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        request_id: 'req_live',
      });
    }
    if (url.endsWith('/v1/runs') && method === 'POST') {
      captured.runBody = JSON.parse(String(init?.body ?? '{}'));
      return json({
        id: 'run_live1',
        object: 'agent.run',
        status: 'queued',
        machine_id: (captured.runBody?.machine_id as string) ?? 'm',
        task: captured.runBody?.task ?? '',
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
        webhook_url: captured.runBody?.webhook_url ?? null,
        webhook_secret: captured.runBody?.webhook_url ? 'whsec_live' : null,
        created_at: new Date().toISOString(),
        started_at: null,
        awaiting_human_since: null,
        finished_at: null,
        request_id: 'req_live',
      });
    }
    // Event streams (Ingestor) and anything else: 404 — the ingestor swallows it.
    return json(
      { error: { code: 'NOT_FOUND', message: 'n/a', type: 'not_found_error', request_id: 'r' } },
      404,
    );
  }) as unknown as typeof fetch;
}

let built: BuiltServer | null = null;
let base = '';

async function start(publicUrl: string, captured: Captured): Promise<string> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const config = loadConfig({
    COASTY_API_KEY: LIVE_KEY, // → coastyBaseUrl resolves to the REAL https://coasty.ai/v1 (non-local)
    COWORK_PUBLIC_URL: publicUrl,
    COWORK_DB_PATH: ':memory:',
    COWORK_SESSION_SECRET: 'webhook-gating-test-secret-32char',
  });
  warn.mockRestore();
  built = buildServer({ config, fetchImpl: coastySpy(captured) });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
}

async function token(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gating@example.com' }),
  });
  return ((await res.json()) as { token: string }).token;
}

afterEach(async () => {
  await built?.app.close();
  built = null;
  base = '';
});

describe('webhook_url gating against a real (non-local) Coasty upstream', () => {
  it('non-https COWORK_PUBLIC_URL → run is created with webhook_url omitted (no more 422)', async () => {
    const captured: Captured = {};
    base = await start('http://127.0.0.1:4000', captured);
    const t = await token();
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        machineId: 'm_live',
        task: 'rename files',
        maxSteps: 25,
        confirmCostCents: 125,
      }),
    });
    expect(res.status).toBe(201);
    // The exact field the real API would have rejected:
    expect(captured.runBody?.webhook_url).toBeNull();
  });

  it('https COWORK_PUBLIC_URL → webhook_url is registered', async () => {
    const captured: Captured = {};
    base = await start('https://cowork.example.com', captured);
    const t = await token();
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        machineId: 'm_live',
        task: 'rename files',
        maxSteps: 25,
        confirmCostCents: 125,
      }),
    });
    expect(res.status).toBe(201);
    expect(captured.runBody?.webhook_url).toBe('https://cowork.example.com/webhooks/coasty');
  });

  it('workflow runs gate webhook_url the same way (non-https → null)', async () => {
    const captured: Captured = {};
    base = await start('http://127.0.0.1:4000', captured);
    const t = await token();
    const res = await fetch(`${base}/api/workflows/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        budgetCents: 100,
        confirmCostCents: 100,
        definition: { steps: [{ id: 't', type: 'task', task: 'go' }] },
      }),
    });
    expect(res.status).toBe(201);
    expect(captured.workflowRunBody?.webhook_url).toBeNull();
  });
});
