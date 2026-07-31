/**
 * Backend integration for submit-and-forget tasks.
 *
 * Runs the REAL backend over real HTTP against an in-process mock-coasty, so
 * the cost handshake, budget caps, SSE ingestion, webhook reconciliation, and
 * the screenshots proxy are all exercised end to end. Everything is offline and
 * free — the mock never bills anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { taskEstimateCents } from '@open-cowork/core';
import { collectSse, LIVE_STYLE_KEY, pollUntil, startHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface RunDto {
  id: string;
  kind: string;
  machineId: string | null;
  status: string;
  cuaVersion: string;
  maxSteps: number;
  costCents: number;
  stepsCompleted: number;
  budgetCents: number;
  deadlineSeconds: number | null;
  actionPolicy: Record<string, unknown> | null;
  result: { passed?: boolean; summary?: string } | null;
  error: { code?: string; message?: string } | null;
  machine: {
    mode: string;
    status: string;
    id: string | null;
    cleanup: string;
    cleanup_status: string;
  } | null;
}

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];

/** The number the backend will demand the client echo back. */
async function taskConfirm(
  h: Harness,
  body: Record<string, unknown> = {},
): Promise<{ cents: number; breakdown: Record<string, number> }> {
  const res = await h.api('/api/estimate', {
    method: 'POST',
    body: JSON.stringify({ kind: 'task', ...body }),
  });
  const json = (await res.json()) as { cents: number; breakdown: Record<string, number> };
  return json;
}

async function createTask(h: Harness, body: Record<string, unknown> = {}): Promise<Response> {
  const { maxSteps = 10, deadlineSeconds = 3600, ...rest } = body;
  const estimate = await taskConfirm(h, { maxSteps, deadlineSeconds, ...pickEstimateFields(rest) });
  return h.api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      task: 'Download the newest invoice and verify it',
      maxSteps,
      deadlineSeconds,
      confirmCostCents: estimate.cents,
      ...rest,
    }),
  });
}

/** Only the fields that change the price belong in the estimate request. */
function pickEstimateFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.cuaVersion !== undefined) out.cuaVersion = body.cuaVersion;
  if (body.osType !== undefined) out.osType = body.osType;
  return out;
}

const getRun = async (h: Harness, id: string): Promise<RunDto> =>
  (await (await h.api(`/api/runs/${id}`)).json()) as RunDto;

const untilTerminal = (h: Harness, id: string) =>
  pollUntil(async () => {
    const run = await getRun(h, id);
    return TERMINAL.includes(run.status) ? run : false;
  });

// ── estimates ────────────────────────────────────────────────────────────────

describe('POST /api/estimate — kind: task', () => {
  it('quotes both meters and matches core exactly', async () => {
    h = await startHarness();
    const est = await taskConfirm(h, { maxSteps: 10, deadlineSeconds: 3600, osType: 'linux' });
    const expected = taskEstimateCents({ maxSteps: 10, deadlineSeconds: 3600, osType: 'linux' });
    expect(est.cents).toBe(expected.maxCents);
    expect(est.breakdown.stepsCents).toBe(50);
    expect(est.breakdown.machineCents).toBe(5);
  });

  it('quotes strictly more than the equivalent run — the delta is the machine', async () => {
    h = await startHarness();
    const task = await taskConfirm(h, { maxSteps: 10, deadlineSeconds: 3600 });
    const runRes = await h!.api('/api/estimate', {
      method: 'POST',
      body: JSON.stringify({ kind: 'run', cuaVersion: 'v5', maxSteps: 10 }),
    });
    const run = (await runRes.json()) as { cents: number };
    expect(task.cents - run.cents).toBe(task.breakdown.machineCents);
  });

  it('accepts every shipped engine, including v5', async () => {
    h = await startHarness();
    for (const cuaVersion of ['v1', 'v3', 'v4', 'v5']) {
      const res = await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'task', cuaVersion, maxSteps: 2 }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('rejects an out-of-range deadline', async () => {
    h = await startHarness();
    const res = await h.api('/api/estimate', {
      method: 'POST',
      body: JSON.stringify({ kind: 'task', deadlineSeconds: 86401 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── the confirm-the-cost handshake ───────────────────────────────────────────

describe('POST /api/tasks — spend safety', () => {
  it('rejects a stale confirmation and names the expected value', async () => {
    h = await startHarness();
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        maxSteps: 10,
        deadlineSeconds: 3600,
        confirmCostCents: 1,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { expectedCents: number; machineCents: number } };
    };
    expect(body.error.code).toBe('ESTIMATE_CHANGED');
    expect(body.error.details.expectedCents).toBe(
      taskEstimateCents({ maxSteps: 10, deadlineSeconds: 3600 }).maxCents,
    );
    expect(body.error.details.machineCents).toBe(5);
  });

  it('rejects a RUN-shaped confirmation, which would under-quote the machine', async () => {
    // The exact mistake a client makes by reusing its run code path.
    h = await startHarness();
    const runRes = await h.api('/api/estimate', {
      method: 'POST',
      body: JSON.stringify({ kind: 'run', cuaVersion: 'v5', maxSteps: 10 }),
    });
    const run = (await runRes.json()) as { cents: number };
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        maxSteps: 10,
        deadlineSeconds: 3600,
        confirmCostCents: run.cents,
      }),
    });
    expect(res.status).toBe(409);
  });

  it('refuses a task whose worst case exceeds the budget, with a fitting step count', async () => {
    h = await startHarness({ defaultBudgetCents: 60 });
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        maxSteps: 1000,
        deadlineSeconds: 3600,
        confirmCostCents: taskEstimateCents({ maxSteps: 1000, deadlineSeconds: 3600 }).maxCents,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { suggestedMaxSteps: number; machineCents: number } };
    };
    expect(body.error.code).toBe('BUDGET_EXCEEDED');
    // Budget 60 - 5 machine = 55 left for steps at 5c each = 11.
    expect(body.error.details.suggestedMaxSteps).toBe(11);
    // And the suggestion actually fits.
    const retry = await createTask(h, { maxSteps: body.error.details.suggestedMaxSteps });
    expect(retry.status).toBe(201);
  });

  it('suggests no step count when the machine alone already breaks the budget', async () => {
    // A longer deadline can exceed the cap before a single step is taken;
    // suggesting "0 steps" would be nonsense, so the field is null.
    h = await startHarness({ defaultBudgetCents: 3 });
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        maxSteps: 1,
        deadlineSeconds: 86400,
        confirmCostCents: taskEstimateCents({ maxSteps: 1, deadlineSeconds: 86400 }).maxCents,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { suggestedMaxSteps: number | null } } };
    expect(body.error.details.suggestedMaxSteps).toBeNull();
  });

  it('clamps a caller-supplied budget to the account cap', async () => {
    h = await startHarness({ defaultBudgetCents: 60 });
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        maxSteps: 1000,
        deadlineSeconds: 3600,
        budgetCents: 1_000_000,
        confirmCostCents: taskEstimateCents({ maxSteps: 1000, deadlineSeconds: 3600 }).maxCents,
      }),
    });
    expect(res.status).toBe(422);
    expect(
      ((await res.json()) as { error: { details: { budgetCents: number } } }).error.details
        .budgetCents,
    ).toBe(60);
  });

  it('surfaces the provisioning gate as a 402 before anything is created', async () => {
    h = await startHarness({ apiKey: LIVE_STYLE_KEY, walletCents: 5 });
    const res = await createTask(h);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_CREDITS',
    );
    // Nothing was persisted.
    const list = (await (await h.api('/api/runs')).json()) as { runs: RunDto[] };
    expect(list.runs).toHaveLength(0);
  });
});

// ── validation ───────────────────────────────────────────────────────────────

describe('POST /api/tasks — validation', () => {
  it('requires a non-empty task and bounds max_steps / deadline', async () => {
    h = await startHarness();
    const bad = [
      { task: '' },
      { maxSteps: 0 },
      { maxSteps: 1001 },
      { deadlineSeconds: 0 },
      { deadlineSeconds: 86401 },
      { osType: 'plan9' },
      { machineProvider: 'gcp' },
    ];
    for (const patch of bad) {
      const res = await h.api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ task: 'go', confirmCostCents: 1, ...patch }),
      });
      expect([patch, res.status]).toEqual([patch, 400]);
    }
  });

  it('rejects a malformed action policy before it costs anything', async () => {
    h = await startHarness();
    const res = await h.api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task: 'go',
        confirmCostCents: 1,
        actionPolicy: { allowed_actions: ['click'], blocked_actions: ['click'] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('pins a valid action policy to the run as the audit record', async () => {
    // Coasty never echoes the normalized policy, so what we stored IS the
    // record of what was submitted.
    h = await startHarness();
    const policy = { blocked_keys: ['escape'], block_window_close: true, max_actions: 5 };
    const res = await createTask(h, { actionPolicy: policy });
    expect(res.status).toBe(201);
    const run = (await res.json()) as RunDto;
    expect(run.actionPolicy).toEqual(policy);
    expect((await getRun(h, run.id)).actionPolicy).toEqual(policy);
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('POST /api/tasks — lifecycle', () => {
  it('creates a task run with kind=task, a null machine, and the pinned deadline', async () => {
    h = await startHarness();
    const run = (await (await createTask(h, { deadlineSeconds: 1800 })).json()) as RunDto;
    expect(run.kind).toBe('task');
    expect(run.machineId).toBeNull();
    expect(run.deadlineSeconds).toBe(1800);
    expect(run.machine?.status).toBe('provisioning');
    expect(run.machine?.cleanup).toBe('always');
  });

  it('defaults to the v5 engine', async () => {
    h = await startHarness();
    const run = (await (await createTask(h)).json()) as RunDto;
    expect(run.cuaVersion).toBe('v5');
  });

  it('fills in machine_id once provisioning completes, then runs to success', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const provisioned = await pollUntil(async () => {
      const run = await getRun(h!, created.id);
      return run.machineId ? run : false;
    });
    expect(provisioned.machineId).toMatch(/^mch_test_/);

    const done = await untilTerminal(h, created.id);
    expect(done.status).toBe('succeeded');
    expect(done.result?.passed).toBe(true);
    expect(done.stepsCompleted).toBeGreaterThan(0);
  });

  it('appears in the runs list alongside ordinary runs', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const list = (await (await h.api('/api/runs')).json()) as { runs: RunDto[] };
    const found = list.runs.find((r) => r.id === created.id);
    expect(found?.kind).toBe('task');
  });

  it('streams the same SSE timeline as a cloud run', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const events = await collectSse(`${h.backendUrl}/api/runs/${created.id}/events`, h.token, {
      until: (e) => e.type === 'done',
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('status');
    expect(types).toContain('step');
    expect(types).toContain('billing');
    expect(types.at(-1)).toBe('done');
    // seq is strictly increasing with no gaps or duplicates.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('can be cancelled like any run', async () => {
    // A long run so there is something to cancel, and a budget big enough that
    // the step count is not rejected before it starts.
    h = await startHarness({
      defaultBudgetCents: 5000,
      mockOpts: { tickMs: 20, defaultRunSteps: 100 },
    });
    const createRes = await createTask(h, { maxSteps: 100 });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as RunDto;
    const res = await h.api(`/api/runs/${created.id}/cancel`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const done = await untilTerminal(h, created.id);
    expect(done.status).toBe('cancelled');
  });

  it('REFUSES to resume — a task never pauses, so there is nothing to resume', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const res = await h.api(`/api/runs/${created.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ note: 'go on' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_SUPPORTED');
    expect(body.error.message).toMatch(/never pause/i);
  });

  it('reconciles the machine cleanup status through to the client', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const cleaned = await pollUntil(async () => {
      const run = await getRun(h!, created.id);
      return run.machine?.cleanup_status === 'terminated' ? run : false;
    });
    expect(cleaned.status).toBe('succeeded');
    expect(cleaned.machine?.status).toBe('released');
  });

  it('surfaces a provisioning failure as a failed run with the underlying code', async () => {
    h = await startHarness();
    const created = (await (
      await createTask(h, { task: 'PROVISION_FAIL download the invoice' })
    ).json()) as RunDto;
    const done = await untilTerminal(h, created.id);
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('MACHINE_PROVISION_FAILED');
    expect(done.machineId).toBeNull();
  });

  it('reports cleanup still retrying without claiming the machine was destroyed', async () => {
    h = await startHarness();
    const created = (await (
      await createTask(h, { task: 'CLEANUP_STUCK download the invoice' })
    ).json()) as RunDto;
    const stuck = await pollUntil(async () => {
      const run = await getRun(h!, created.id);
      return run.machine?.cleanup_status === 'retrying' ? run : false;
    });
    expect(TERMINAL).toContain(stuck.status);
    expect(stuck.machine?.cleanup_status).not.toBe('terminated');
  });
});

// ── screenshots proxy ────────────────────────────────────────────────────────

describe('GET /api/runs/:id/screenshots', () => {
  interface Page {
    object: string;
    data: { index: number; image_b64?: string; image_unavailable?: boolean }[];
    has_more: boolean;
  }

  it('proxies metadata without inlining images', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    await untilTerminal(h, created.id);
    const page = (await (await h.api(`/api/runs/${created.id}/screenshots`)).json()) as Page;
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]).not.toHaveProperty('image_b64');
  });

  it('sets Cache-Control: no-store when bytes are inlined', async () => {
    // Frames can show an inbox or a billing page — never let one land in a cache.
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    await untilTerminal(h, created.id);
    const res = await h.api(`/api/runs/${created.id}/screenshots?includeImage=true`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = (await res.json()) as Page;
    expect(page.data[0]!.image_b64).toBeTruthy();
  });

  it('pages with afterIndex', async () => {
    h = await startHarness({ mockOpts: { tickMs: 5, defaultRunSteps: 6 } });
    const created = (await (await createTask(h)).json()) as RunDto;
    await untilTerminal(h, created.id);
    const page = (await (
      await h.api(`/api/runs/${created.id}/screenshots?afterIndex=2`)
    ).json()) as Page;
    expect(page.data.map((f) => f.index)).toEqual([3, 4, 5]);
  });

  it('rejects a negative afterIndex', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    const res = await h.api(`/api/runs/${created.id}/screenshots?afterIndex=-1`);
    expect(res.status).toBe(400);
  });

  it('404s a run belonging to nobody', async () => {
    h = await startHarness();
    const res = await h.api('/api/runs/r_missing/screenshots');
    expect(res.status).toBe(404);
  });

  it('returns an empty page for a LOCAL run instead of a 404', async () => {
    // Local runs never reach Coasty, so there are no stored frames — but one
    // client code path should work for every run kind.
    h = await startHarness();
    const local = (await (
      await h.api('/api/local-runs', {
        method: 'POST',
        body: JSON.stringify({ task: 'local job', maxSteps: 3 }),
      })
    ).json()) as RunDto;
    const res = await h.api(`/api/runs/${local.id}/screenshots`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
  });

  it('still serves frames after the ephemeral machine is destroyed', async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;
    await pollUntil(async () => {
      const run = await getRun(h!, created.id);
      return run.machine?.cleanup_status === 'terminated' ? run : false;
    });
    const page = (await (
      await h.api(`/api/runs/${created.id}/screenshots?includeImage=true`)
    ).json()) as Page;
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]!.image_b64).toBeTruthy();
  });
});

// ── isolation ────────────────────────────────────────────────────────────────

describe('task runs are scoped to their owner', () => {
  it("another user's token cannot read a task run or its frames", async () => {
    h = await startHarness();
    const created = (await (await createTask(h)).json()) as RunDto;

    const loginRes = await fetch(`${h.backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone-else@example.com' }),
    });
    const { token } = (await loginRes.json()) as { token: string };
    const asOther = (path: string) =>
      fetch(`${h!.backendUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

    expect((await asOther(`/api/runs/${created.id}`)).status).toBe(404);
    expect((await asOther(`/api/runs/${created.id}/screenshots`)).status).toBe(404);
  });

  it('rejects an unauthenticated task create', async () => {
    h = await startHarness();
    const res = await fetch(`${h.backendUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'go', confirmCostCents: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
