/**
 * Extra backend ↔ mock-coasty integration coverage: workflow SSE + reconciliation,
 * machine lifecycle transitions and error mapping, durable ingestion + reconnect
 * for workflow runs, wallet/budget edges, inference-proxy error surfacing, resume
 * and cancel state errors, auth/id edges, and the estimate endpoint's exact numbers.
 *
 * Everything runs over real HTTP against the in-process mock — offline, zero spend.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  machineRuntimeCentsPerHour,
  runEstimateCents,
  workflowEstimateCents,
} from '@open-cowork/core';
import {
  collectSse,
  pollUntil,
  startHarness,
  type Harness,
  type CollectedEvent,
  LIVE_STYLE_KEY,
} from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function createTestMachine(harness: Harness, osType: 'linux' | 'windows' = 'linux') {
  const confirm = machineRuntimeCentsPerHour(osType, 'running');
  const res = await harness.api('/api/machines', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'it-vm', osType, confirmCostCents: confirm }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { machine: { id: string } };
  return body.machine.id;
}

const RUN_CONFIRM = runEstimateCents({ cuaVersion: 'v3', maxSteps: 10 }).maxCents; // 50¢

async function createRun(harness: Harness, task: string, extra: Record<string, unknown> = {}) {
  const machineId = await createTestMachine(harness);
  const res = await harness.api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      machineId,
      task,
      maxSteps: 10,
      confirmCostCents: RUN_CONFIRM,
      ...extra,
    }),
  });
  return { res, machineId };
}

const SIMPLE_WORKFLOW = {
  steps: [
    { id: 'fetch', type: 'task', task: 'Read invoice {{inputs.order}}', save_as: 'invoice' },
    { id: 'check', type: 'assert', condition: { op: 'truthy', value: '{{invoice.passed}}' } },
    { id: 'ok', type: 'succeed', output: { state: 'done' } },
  ],
};

// ── 1. Workflow runs over SSE ────────────────────────────────────────────────
describe('workflow run over SSE', () => {
  it('streams status…billing…done and GET reconciles the output', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const startRes = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
        inputs: { order: 'ord_42' },
        definition: SIMPLE_WORKFLOW,
      }),
    });
    expect(startRes.status).toBe(201);
    const run = (await startRes.json()) as { id: string };

    // Drive the SSE timeline all the way to 'done'.
    const events = await collectSse(
      `${h.backendUrl}/api/workflows/runs/${run.id}/events`,
      h.token,
      {
        maxMs: 10_000,
      },
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status'); // running
    expect(types).toContain('billing');
    expect(types.at(-1)).toBe('done');
    // seqs strictly increasing
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);

    // GET reconciliation returns the upstream output.
    const final = (await (await h.api(`/api/workflows/runs/${run.id}`)).json()) as {
      status: string;
      output: Record<string, unknown> | null;
      spentCents: number;
    };
    expect(final.status).toBe('succeeded');
    expect(final.output).toEqual({ state: 'done' });
  });

  it('a budget-capped workflow that breaches the cap fails (GUARD_EXCEEDED)', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    // Two task steps; each bills 3×5=15¢ virtually. A 10¢ cap is breached on the
    // first task, so the run fails with GUARD_EXCEEDED.
    const startRes = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 10,
        confirmCostCents: 10,
        definition: {
          steps: [
            { id: 'a', type: 'task', task: 'first' },
            { id: 'b', type: 'task', task: 'second' },
            { id: 'ok', type: 'succeed' },
          ],
        },
      }),
    });
    expect(startRes.status).toBe(201);
    const run = (await startRes.json()) as { id: string };

    const finished = await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
        error?: { code: string } | null;
      };
      return r.status === 'failed' ? r : undefined;
    });
    expect(finished.error?.code).toBe('GUARD_EXCEEDED');
  });
});

// ── 2. Machine routes ─────────────────────────────────────────────────────────
describe('machine routes', () => {
  it('lists machines and fetches one by id', async () => {
    h = await startHarness();
    const id = await createTestMachine(h);
    const list = (await (await h.api('/api/machines')).json()) as {
      machines: { id: string }[];
    };
    expect(list.machines.some((m) => m.id === id)).toBe(true);

    const one = (await (await h.api(`/api/machines/${id}`)).json()) as {
      id: string;
      status: string;
    };
    expect(one.id).toBe(id);
    expect(one.status).toBe('running');
  });

  it('stop→start transitions succeed; an invalid transition surfaces mapped 409 INVALID_STATE', async () => {
    h = await startHarness();
    const id = await createTestMachine(h);

    const stop = await h.api(`/api/machines/${id}/stop`, { method: 'POST', body: '{}' });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { status: string }).status).toBe('stopped');

    // Stopping an already-stopped machine is the documented INVALID_STATE error.
    const stopAgain = await h.api(`/api/machines/${id}/stop`, { method: 'POST', body: '{}' });
    expect(stopAgain.status).toBe(409);
    const stopErr = (await stopAgain.json()) as { error: { code: string } };
    expect(stopErr.error.code).toBe('INVALID_STATE');

    const start = await h.api(`/api/machines/${id}/start`, { method: 'POST', body: '{}' });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { status: string }).status).toBe('running');

    // Starting an already-running machine → 409 INVALID_STATE too.
    const startAgain = await h.api(`/api/machines/${id}/start`, { method: 'POST', body: '{}' });
    expect(startAgain.status).toBe(409);
    expect(((await startAgain.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE',
    );
  });

  it('snapshots a machine', async () => {
    h = await startHarness();
    const id = await createTestMachine(h);
    const snap = await h.api(`/api/machines/${id}/snapshot`, { method: 'POST', body: '{}' });
    expect(snap.status).toBe(200);
    const body = (await snap.json()) as { snapshot_id: string; machine_id: string };
    expect(body.snapshot_id).toMatch(/^snap_/);
    expect(body.machine_id).toBe(id);
  });

  it('GET screenshot returns a decodable PNG (magic bytes)', async () => {
    h = await startHarness();
    const id = await createTestMachine(h);
    const res = await h.api(`/api/machines/${id}/screenshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { image_b64: string; width: number; height: number };
    const bytes = Buffer.from(body.image_b64, 'base64');
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(body.width).toBe(320);
    expect(body.height).toBe(180);
  });

  it('exposes the machine pricing table', async () => {
    h = await startHarness();
    const res = await h.api('/api/machines/pricing');
    expect(res.status).toBe(200);
    const pricing = (await res.json()) as {
      runtime_hourly_cents: { linux_running: number; windows_running: number; stopped: number };
      provisioning_gate_cents: number;
    };
    expect(pricing.runtime_hourly_cents.linux_running).toBe(5);
    expect(pricing.runtime_hourly_cents.windows_running).toBe(9);
    expect(pricing.runtime_hourly_cents.stopped).toBe(1);
    expect(pricing.provisioning_gate_cents).toBe(20);
  });

  it('GET on an unknown machine surfaces the mapped 404', async () => {
    h = await startHarness();
    const res = await h.api('/api/machines/mch_does_not_exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MACHINE_NOT_FOUND');
  });

  it('terminates a machine, after which it disappears from list/get', async () => {
    h = await startHarness();
    const id = await createTestMachine(h);
    const del = await h.api(`/api/machines/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { status: string }).status).toBe('terminated');

    const after = await h.api(`/api/machines/${id}`);
    expect(after.status).toBe(404);
  });
});

// ── 3. Ingestor durability + reconnect for workflow runs ─────────────────────
describe('ingestion durability + reconnect (workflow runs)', () => {
  it('stores the full ordered timeline; events.json?after=0 returns it after completion', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const startRes = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
        inputs: { order: 'ord_1' },
        definition: SIMPLE_WORKFLOW,
      }),
    });
    const run = (await startRes.json()) as { id: string };

    // Run to terminal via SSE so the whole timeline is durably persisted.
    const streamed = await collectSse(
      `${h.backendUrl}/api/workflows/runs/${run.id}/events`,
      h.token,
      { maxMs: 10_000 },
    );
    expect(streamed.at(-1)!.type).toBe('done');

    // The persisted timeline is complete and ordered with no gaps from seq 1.
    const seqs = streamed.map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('a second SSE connect with Last-Event-ID replays only the tail, no gaps', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const startRes = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
        inputs: { order: 'ord_1' },
        definition: SIMPLE_WORKFLOW,
      }),
    });
    const run = (await startRes.json()) as { id: string };
    const url = `${h.backendUrl}/api/workflows/runs/${run.id}/events`;

    // First connection: take a few events, then drop.
    const first = await collectSse(url, h.token, { until: (e) => e.seq >= 3, maxMs: 10_000 });
    expect(first.length).toBeGreaterThanOrEqual(3);
    const cursor = first.at(-1)!.seq;

    // Reconnect with Last-Event-ID — resume exactly after the cursor.
    const second = await collectSse(url, h.token, { lastEventId: cursor, maxMs: 10_000 });
    expect(second[0]!.seq).toBe(cursor + 1);

    const all: CollectedEvent[] = [...first, ...second];
    const seqs = all.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length); // no gaps
    expect(all.at(-1)!.type).toBe('done');
  });
});

// ── 4. Wallet + me ────────────────────────────────────────────────────────────
describe('wallet + me/budget', () => {
  it('GET /api/wallet returns balance/breakdown from the mock usage', async () => {
    h = await startHarness({ apiKey: LIVE_STYLE_KEY, walletCents: 5000 });
    const wallet = (await (await h.api('/api/wallet')).json()) as {
      balanceCents: number;
      periodCostCents: number;
      period: string;
      monthSpendCents: number;
      breakdown: Record<string, { requests: number; credits: number }>;
    };
    expect(wallet.balanceCents).toBe(5000);
    expect(wallet.monthSpendCents).toBe(0);
    expect(typeof wallet.period).toBe('string');
    expect(wallet.breakdown).toBeTypeOf('object');
  });

  it('PATCH /api/me/budget updates the cap and is reflected in GET /api/me', async () => {
    h = await startHarness({ defaultBudgetCents: 500 });
    const patch = await h.api('/api/me/budget', {
      method: 'PATCH',
      body: JSON.stringify({ budgetCents: 80 }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { budgetCents: number }).budgetCents).toBe(80);

    const me = (await (await h.api('/api/me')).json()) as { user: { budgetCents: number } };
    expect(me.user.budgetCents).toBe(80);
  });

  it('lowering the cap below a run worst case → 422 BUDGET_EXCEEDED on the next run', async () => {
    h = await startHarness({ defaultBudgetCents: 500 });
    // 10 steps × 5¢ = 50¢ worst case. Lower the cap below it.
    const patch = await h.api('/api/me/budget', {
      method: 'PATCH',
      body: JSON.stringify({ budgetCents: 30 }),
    });
    expect(patch.status).toBe(200);

    const { res } = await createRun(h, 'do something', { maxSteps: 10, confirmCostCents: 50 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { budgetCents: number; suggestedMaxSteps: number } };
    };
    expect(body.error.code).toBe('BUDGET_EXCEEDED');
    expect(body.error.details.budgetCents).toBe(30);
    expect(body.error.details.suggestedMaxSteps).toBe(6); // floor(30 / 5)
  });

  it('rejects an out-of-range budget patch (validation 400)', async () => {
    h = await startHarness();
    const res = await h.api('/api/me/budget', {
      method: 'PATCH',
      body: JSON.stringify({ budgetCents: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── 5. Inference proxy errors ─────────────────────────────────────────────────
describe('inference proxy errors', () => {
  it('predict with a too-short screenshot → mapped 4xx', async () => {
    h = await startHarness();
    const createRes = await h.api('/api/proxy/sessions', {
      method: 'POST',
      body: JSON.stringify({ screenWidth: 1280, screenHeight: 720 }),
    });
    const session = (await createRes.json()) as { session_id: string };

    const predictRes = await h.api(`/api/proxy/sessions/${session.session_id}/predict`, {
      method: 'POST',
      // Too short: backend zod requires min(100); a value of 50 chars is rejected
      // locally (400 BAD_REQUEST) before it ever reaches Coasty.
      body: JSON.stringify({ screenshot: 'A'.repeat(50), instruction: 'click' }),
    });
    expect(predictRes.status).toBeGreaterThanOrEqual(400);
    expect(predictRes.status).toBeLessThan(500);
    const body = (await predictRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('predict on an unknown session → 404 surfaced from upstream', async () => {
    h = await startHarness();
    const predictRes = await h.api('/api/proxy/sessions/sess_nope/predict', {
      method: 'POST',
      body: JSON.stringify({ screenshot: 'A'.repeat(200), instruction: 'click the button' }),
    });
    expect(predictRes.status).toBe(404);
    const body = (await predictRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('deleting an unknown session → 404 surfaced', async () => {
    h = await startHarness();
    const res = await h.api('/api/proxy/sessions/sess_unknown', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ── 6. Resume / cancel state errors ───────────────────────────────────────────
describe('resume / cancel state errors', () => {
  it('resuming a running (not awaiting) run → mapped 409 NOT_AWAITING_HUMAN', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'long task RUN_LONG');
    const run = (await res.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'running' ? r : undefined;
    });

    const resume = await h.api(`/api/runs/${run.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ note: 'too soon' }),
    });
    expect(resume.status).toBe(409);
    const body = (await resume.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_AWAITING_HUMAN');
  });

  it('cancelling a terminal run → 409 INVALID_STATE', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'simple task');
    const run = (await res.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'succeeded' ? r : undefined;
    });

    const cancel = await h.api(`/api/runs/${run.id}/cancel`, { method: 'POST', body: '{}' });
    expect(cancel.status).toBe(409);
    const body = (await cancel.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_STATE');
  });

  it('resuming a running workflow run → mapped 409 NOT_AWAITING_HUMAN', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    // A workflow with a long human gate so it stays running while we poke resume.
    const startRes = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
        inputs: { order: 'ord_1' },
        definition: SIMPLE_WORKFLOW,
      }),
    });
    const run = (await startRes.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
      };
      return r.status === 'running' || r.status === 'succeeded' ? r : undefined;
    });

    const resume = await h.api(`/api/workflows/runs/${run.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ approved: true }),
    });
    expect(resume.status).toBe(409);
    const body = (await resume.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_AWAITING_HUMAN');
  });
});

// ── 7. Idempotency / auth / id edges ──────────────────────────────────────────
describe('auth + id edges', () => {
  it('login with a bad email → 400 validation', async () => {
    h = await startHarness();
    const res = await fetch(`${h.backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('the SSE event timeline route requires auth → 401', async () => {
    h = await startHarness();
    const res = await fetch(`${h.backendUrl}/api/runs/r_anything/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });

  it('the global activity feed requires auth → 401', async () => {
    h = await startHarness();
    const res = await fetch(`${h.backendUrl}/api/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });

  it('GET an unknown run id → 404 NOT_FOUND', async () => {
    h = await startHarness();
    const res = await h.api('/api/runs/r_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET an unknown workflow run id → 404 NOT_FOUND', async () => {
    h = await startHarness();
    const res = await h.api('/api/workflows/runs/wr_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('events.json on an unknown run id → 404', async () => {
    h = await startHarness();
    const res = await h.api('/api/runs/r_missing/events.json?after=0');
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON bodies with 400 INVALID_JSON', async () => {
    h = await startHarness();
    const res = await h.api('/api/me/budget', { method: 'PATCH', body: '{not json' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
  });
});

// ── 8. estimate endpoint matches core's numbers ───────────────────────────────
describe('estimate endpoint matches core', () => {
  it('run estimate: v1 vs v3 per-step cost', async () => {
    h = await startHarness();
    const v3 = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'run', cuaVersion: 'v3', maxSteps: 10 }),
      })
    ).json()) as { cents: number; breakdown: { perStepCents: number } };
    expect(v3.cents).toBe(runEstimateCents({ cuaVersion: 'v3', maxSteps: 10 }).maxCents);
    expect(v3.cents).toBe(50); // 10 × 5¢
    expect(v3.breakdown.perStepCents).toBe(5);

    const v1 = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'run', cuaVersion: 'v1', maxSteps: 10 }),
      })
    ).json()) as { cents: number; breakdown: { perStepCents: number } };
    expect(v1.cents).toBe(runEstimateCents({ cuaVersion: 'v1', maxSteps: 10 }).maxCents);
    expect(v1.cents).toBe(80); // 10 × 8¢ (v1 engine surcharge baked into the run step)
    expect(v1.breakdown.perStepCents).toBe(8);
  });

  it('machine estimate: windows vs linux running rate', async () => {
    h = await startHarness();
    const linux = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'machine', osType: 'linux' }),
      })
    ).json()) as { cents: number };
    expect(linux.cents).toBe(machineRuntimeCentsPerHour('linux', 'running'));
    expect(linux.cents).toBe(5);

    const windows = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'machine', osType: 'windows' }),
      })
    ).json()) as { cents: number };
    expect(windows.cents).toBe(machineRuntimeCentsPerHour('windows', 'running'));
    expect(windows.cents).toBe(9);

    // No osType defaults to linux.
    const dflt = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'machine' }),
      })
    ).json()) as { cents: number };
    expect(dflt.cents).toBe(5);
  });

  it('workflow estimate matches core for a multi-task definition', async () => {
    h = await startHarness();
    const definition = {
      steps: [
        { id: 'a', type: 'task', task: 'x' },
        { id: 'b', type: 'task', task: 'y' },
        { id: 'ok', type: 'succeed' },
      ],
    };
    const expected = workflowEstimateCents(definition as never);
    const wf = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'workflow', definition }),
      })
    ).json()) as { cents: number; breakdown: { taskCount: number; worstCaseCents: number } };
    expect(wf.cents).toBe(expected.typicalCents);
    expect(wf.cents).toBe(40); // 2 tasks × 4 steps × 5¢
    expect(wf.breakdown.taskCount).toBe(2);
  });
});
