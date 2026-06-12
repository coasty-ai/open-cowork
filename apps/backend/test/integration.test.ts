/**
 * Backend ↔ mock-coasty integration: the full proxy + persistence + realtime
 * stack over real HTTP, fully offline, zero spend.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runEstimateCents, signWebhookPayload } from '@open-cowork/core';
import { collectSse, pollUntil, startHarness, type Harness, LIVE_STYLE_KEY } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function createTestMachine(harness: Harness): Promise<string> {
  const res = await harness.api('/api/machines', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'it-vm', osType: 'linux', confirmCostCents: 5 }),
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

describe('auth', () => {
  it('rejects missing/invalid tokens and accepts a fresh login', async () => {
    h = await startHarness();
    const anon = await fetch(`${h.backendUrl}/api/runs`);
    expect(anon.status).toBe(401);
    const bad = await fetch(`${h.backendUrl}/api/runs`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(bad.status).toBe(401);
    const ok = await h.api('/api/runs');
    expect(ok.status).toBe(200);
  });

  it('GET /api/me returns the user and month spend', async () => {
    h = await startHarness();
    const me = (await (await h.api('/api/me')).json()) as {
      user: { email: string; budgetCents: number };
      monthSpendCents: number;
    };
    expect(me.user.email).toBe('tester@example.com');
    expect(me.user.budgetCents).toBe(500);
    expect(me.monthSpendCents).toBe(0);
  });
});

describe('estimates + spend safety', () => {
  it('POST /api/estimate computes run/machine/workflow estimates', async () => {
    h = await startHarness();
    const run = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'run', maxSteps: 40 }),
      })
    ).json()) as { cents: number };
    expect(run.cents).toBe(200);
    const machine = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'machine', osType: 'windows' }),
      })
    ).json()) as { cents: number };
    expect(machine.cents).toBe(9);
    const wf = (await (
      await h.api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'workflow',
          definition: { steps: [{ id: 't', type: 'task', task: 'x' }] },
        }),
      })
    ).json()) as { cents: number };
    expect(wf.cents).toBe(20); // 1 task × 4 steps × 5¢
  });

  it('rejects a run whose worst case exceeds the budget cap (422 + suggestion)', async () => {
    h = await startHarness({ defaultBudgetCents: 100 });
    const { res } = await createRun(h, 'do something', {
      maxSteps: 100,
      confirmCostCents: 500,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { suggestedMaxSteps: number } };
    };
    expect(body.error.code).toBe('BUDGET_EXCEEDED');
    expect(body.error.details.suggestedMaxSteps).toBe(20); // 100¢ / 5¢
  });

  it('rejects a stale confirmCostCents (409 ESTIMATE_CHANGED with the expected value)', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'task', { confirmCostCents: RUN_CONFIRM - 1 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { expectedCents: number } };
    };
    expect(body.error.code).toBe('ESTIMATE_CHANGED');
    expect(body.error.details.expectedCents).toBe(RUN_CONFIRM);
  });

  it('surfaces 402 INSUFFICIENT_CREDITS when the wallet cannot cover a step', async () => {
    h = await startHarness({ apiKey: LIVE_STYLE_KEY, walletCents: 3 });
    const machineRes = await h.api('/api/machines', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'vm', confirmCostCents: 5 }),
    });
    // Provisioning gate also fails at 3¢ < 20¢ — that's the first 402 we hit.
    expect(machineRes.status).toBe(402);
    const body = (await machineRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('cloud run lifecycle', () => {
  it('delegates a task → streams events → completes with a cost summary', async () => {
    // Live-style key so per-step billing is visible (test keys correctly bill $0).
    h = await startHarness({ apiKey: LIVE_STYLE_KEY, walletCents: 10_000 });
    const { res } = await createRun(h, 'Open the calculator and compute 42 * 17');
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string; status: string };
    expect(['queued', 'running']).toContain(run.status);

    const finished = await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as {
        status: string;
        costCents: number;
      };
      return r.status === 'succeeded' ? r : undefined;
    });
    expect(finished.costCents).toBeGreaterThan(0);

    // Full event timeline is persisted and replayable from seq 0.
    const events = await collectSse(`${h.backendUrl}/api/runs/${run.id}/events`, h.token);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types).toContain('step');
    expect(types).toContain('billing');
    expect(types.at(-1)).toBe('done');
    // seqs strictly increasing
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);
  });

  it('SSE reconnect via Last-Event-ID: no duplicates, no gaps', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'long task RUN_LONG');
    const run = (await res.json()) as { id: string };
    const url = `${h.backendUrl}/api/runs/${run.id}/events`;

    // First connection: take a few events then drop.
    const first = await collectSse(url, h.token, { until: (e) => e.seq >= 4 });
    expect(first.length).toBeGreaterThanOrEqual(4);
    const cursor = first.at(-1)!.seq;

    // Reconnect with Last-Event-ID — must resume exactly after the cursor.
    const second = await collectSse(url, h.token, { lastEventId: cursor, maxMs: 10_000 });
    expect(second[0]!.seq).toBe(cursor + 1);
    const all = [...first, ...second];
    const seqs = all.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length); // no gaps
    expect(all.at(-1)!.type).toBe('done');
  });

  it('awaiting_human → notification on the user feed → resume → succeeded', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'sensitive step NEEDS_HUMAN here');
    const run = (await res.json()) as { id: string };

    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'awaiting_human' ? r : undefined;
    });

    // The global activity feed (replay-capable) carries the awaiting_human notification.
    const feed = await collectSse(`${h.backendUrl}/api/events`, h.token, {
      until: (e) => e.type === 'run.awaiting_human',
      maxMs: 5000,
    });
    expect(feed.some((e) => e.type === 'run.awaiting_human')).toBe(true);

    const resumeRes = await h.api(`/api/runs/${run.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ note: 'approved from the phone' }),
    });
    expect(resumeRes.status).toBe(200);

    const finished = await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'succeeded' ? r : undefined;
    });
    expect(finished).toBeTruthy();
  });

  it('cancel stops an active run', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'long task RUN_LONG');
    const run = (await res.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'running' ? r : undefined;
    });
    const cancelRes = await h.api(`/api/runs/${run.id}/cancel`, { method: 'POST', body: '{}' });
    expect(cancelRes.status).toBe(200);
    const r = (await (await h.api(`/api/runs/${run.id}`)).json()) as { status: string };
    expect(r.status).toBe('cancelled');
  });
});

describe('webhook receiver (HMAC)', () => {
  it("processes the mock's real signed deliveries for terminal runs", async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'simple task');
    const run = (await res.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/runs/${run.id}`)).json()) as { status: string };
      return r.status === 'succeeded' ? r : undefined;
    });
    // The mock delivered at least one webhook to our receiver and it verified.
    await pollUntil(async () =>
      h!.mock.state.webhookDeliveries.length > 0 ? h!.mock.state.webhookDeliveries : undefined,
    );
    // Our notification stream recorded the verified terminal event.
    const notifications = h.built.db.eventsAfter(
      'notification',
      h.built.db.sql.prepare('SELECT id FROM users LIMIT 1').get()!.id as string,
      0,
    );
    expect(notifications.some((n) => n.type === 'run.succeeded')).toBe(true);
  });

  it('rejects tampered bodies and stale timestamps with 401', async () => {
    h = await startHarness();
    const { res } = await createRun(h, 'simple task');
    const run = (await res.json()) as { id: string };
    const row = await pollUntil(async () => {
      const r = h!.built.db.sql.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as
        | { coasty_run_id: string; webhook_secret: string | null }
        | undefined;
      return r?.webhook_secret ? r : undefined;
    });

    const payload = JSON.stringify({
      event: 'run.succeeded',
      run: { id: row.coasty_run_id, object: 'agent.run', status: 'succeeded' },
    });

    // Valid signature over a TAMPERED body → 401.
    const header = await signWebhookPayload({ secret: row.webhook_secret!, body: payload });
    const tampered = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Coasty-Signature': header },
      body: payload.replace('succeeded', 'failed!!!'),
    });
    expect(tampered.status).toBe(401);

    // Stale timestamp (10 minutes old) → 401 even though the HMAC matches.
    const staleHeader = await signWebhookPayload({
      secret: row.webhook_secret!,
      body: payload,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    const stale = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Coasty-Signature': staleHeader },
      body: payload,
    });
    expect(stale.status).toBe(401);

    // Unknown run id → 401 (no state mutation possible without a stored secret).
    const unknownHeader = await signWebhookPayload({ secret: 'whsec_unknown', body: payload });
    const unknown = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Coasty-Signature': unknownHeader },
      body: JSON.stringify({
        event: 'run.succeeded',
        run: { id: 'run_doesnotexist', status: 'succeeded' },
      }),
    });
    expect(unknown.status).toBe(401);
  });
});

describe('local runs (desktop mirror)', () => {
  it('creates, appends events, updates state, and replays over SSE', async () => {
    h = await startHarness();
    const createRes = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'rename the quarterly files locally' }),
    });
    expect(createRes.status).toBe(201);
    const run = (await createRes.json()) as { id: string; kind: string; status: string };
    expect(run.kind).toBe('local');
    expect(run.status).toBe('running');

    const append = await h.api(`/api/local-runs/${run.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { type: 'status', data: { status: 'running' } },
          { type: 'step', data: { steps_completed: 1 } },
          { type: 'billing', data: { cost_cents: 4 } },
          { type: 'done', data: { status: 'succeeded', result: { passed: true } } },
        ],
      }),
    });
    expect(append.status).toBe(200);

    const r = (await (await h.api(`/api/runs/${run.id}`)).json()) as {
      status: string;
      stepsCompleted: number;
      costCents: number;
    };
    expect(r.status).toBe('succeeded');
    expect(r.stepsCompleted).toBe(1);
    expect(r.costCents).toBe(4);

    // The same SSE route used for cloud runs replays the local timeline.
    const events = await collectSse(`${h.backendUrl}/api/runs/${run.id}/events`, h.token);
    expect(events.map((e) => e.type)).toEqual(['status', 'step', 'billing', 'done']);

    // REST polling fallback (mobile) returns the same timeline with a cursor.
    const pollRes = (await (await h.api(`/api/runs/${run.id}/events.json?after=1`)).json()) as {
      events: { seq: number; type: string }[];
      done: boolean;
    };
    expect(pollRes.events.map((e) => e.type)).toEqual(['step', 'billing', 'done']);
    expect(pollRes.done).toBe(true);
  });
});

describe('workflows', () => {
  const definition = {
    steps: [
      { id: 'fetch', type: 'task', task: 'Read invoice {{inputs.order}}', save_as: 'invoice' },
      { id: 'check', type: 'assert', condition: { op: 'truthy', value: '{{invoice.passed}}' } },
      { id: 'ok', type: 'succeed', output: { state: 'done' } },
    ],
  };

  it('rejects invalid definitions locally with structured issues (no upstream call)', async () => {
    h = await startHarness();
    const res = await h.api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad',
        slug: 'bad',
        definition: { steps: [{ id: 'r', type: 'retry', max_attempts: 99, body: [] }] },
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { issues: { code: string }[] } };
    };
    expect(body.error.code).toBe('INVALID_DEFINITION');
    expect(body.error.details.issues.some((i) => i.code === 'INVALID_RETRY')).toBe(true);
  });

  it('creates, starts with a confirmed budget cap, and completes', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const createRes = await h.api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Invoice check', slug: 'invoice-check', definition }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string; version: number };

    const startRes = await h.api(`/api/workflows/${wf.id}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        inputs: { order: 'ord_1' },
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
      }),
    });
    expect(startRes.status).toBe(201);
    const run = (await startRes.json()) as { id: string };

    const finished = await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
        output?: Record<string, unknown> | null;
        spentCents: number;
      };
      return r.status === 'succeeded' ? r : undefined;
    });
    expect(finished.output).toEqual({ state: 'done' });
    expect(finished.spentCents).toBeGreaterThan(0);
  });

  it('human_approval pauses; resume {approved:false} fails the run', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const res = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 100,
        confirmCostCents: 100,
        definition: {
          steps: [
            { id: 'gate', type: 'human_approval', message: 'May I?' },
            { id: 'ok', type: 'succeed' },
          ],
        },
      }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string };

    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
        awaitingStepId: string | null;
      };
      return r.status === 'awaiting_human' && r.awaitingStepId === 'gate' ? r : undefined;
    });

    const reject = await h.api(`/api/workflows/runs/${run.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ approved: false, note: 'not today' }),
    });
    expect(reject.status).toBe(200);

    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
      };
      return r.status === 'failed' ? r : undefined;
    });
  });

  it('budget cap mismatch on start → 409 with typical/worst-case context', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const res = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({ machineId, budgetCents: 100, confirmCostCents: 999, definition }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { expectedCents: number } };
    };
    expect(body.error.code).toBe('ESTIMATE_CHANGED');
    expect(body.error.details.expectedCents).toBe(100);
  });
});

describe('machines', () => {
  it('provisioning requires the rate handshake; mismatch → 409', async () => {
    h = await startHarness();
    const res = await h.api('/api/machines', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'vm', osType: 'windows', confirmCostCents: 5 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { expectedCents: number } } };
    expect(body.error.details.expectedCents).toBe(9); // windows rate
  });

  it('screenshot proxy returns a decodable PNG', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const res = await h.api(`/api/machines/${machineId}/screenshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { image_b64: string; width: number; height: number };
    const bytes = Buffer.from(body.image_b64, 'base64');
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    expect(body.width).toBeGreaterThan(0);
  });

  it('action passthrough is allowlisted: terminal-style commands → 403', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const ok = await h.api(`/api/machines/${machineId}/actions`, {
      method: 'POST',
      body: JSON.stringify({ command: 'click', parameters: { x: 1, y: 2 } }),
    });
    expect(ok.status).toBe(200);
    for (const command of ['terminal_execute', 'file_write', 'browser_execute']) {
      const blocked = await h.api(`/api/machines/${machineId}/actions`, {
        method: 'POST',
        body: JSON.stringify({ command, parameters: {} }),
      });
      expect(blocked.status).toBe(403);
    }
  });
});

describe('inference proxy (desktop local loop)', () => {
  it('proxies session create/predict/delete without exposing the key', async () => {
    h = await startHarness();
    const createRes = await h.api('/api/proxy/sessions', {
      method: 'POST',
      body: JSON.stringify({ screenWidth: 1280, screenHeight: 720 }),
    });
    expect(createRes.status).toBe(200);
    const session = (await createRes.json()) as { session_id: string };
    expect(session.session_id).toMatch(/^sess_/);

    const predictRes = await h.api(`/api/proxy/sessions/${session.session_id}/predict`, {
      method: 'POST',
      body: JSON.stringify({ screenshot: 'A'.repeat(200), instruction: 'click the button' }),
    });
    expect(predictRes.status).toBe(200);
    const prediction = (await predictRes.json()) as { actions: unknown[]; status: string };
    expect(prediction.actions.length).toBeGreaterThan(0);

    const deleteRes = await h.api(`/api/proxy/sessions/${session.session_id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
  });
});
