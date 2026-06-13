/**
 * Route-level coverage for the proxied CRUD + supervision paths that the main
 * lifecycle tests don't exercise: workflow CRUD/validate, list/filter runs,
 * local-run cancel/patch/resume edges, the EventBus user feed, and the webhook
 * receiver's workflow-run branch — all over real HTTP against the mock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { machineRuntimeCentsPerHour, signWebhookPayload } from '@open-cowork/core';
import { EventBus, type BusEvent } from '../src/bus';
import { pollUntil, startHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function createTestMachine(harness: Harness) {
  const res = await harness.api('/api/machines', {
    method: 'POST',
    body: JSON.stringify({
      displayName: 'it-vm',
      osType: 'linux',
      confirmCostCents: machineRuntimeCentsPerHour('linux', 'running'),
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { machine: { id: string } }).machine.id;
}

const WF = {
  steps: [
    { id: 't', type: 'task', task: 'do {{inputs.x}}' },
    { id: 'ok', type: 'succeed', output: { ok: true } },
  ],
};

describe('workflow CRUD (proxied)', () => {
  it('create → get → list → update (version bump) → delete (archive)', async () => {
    h = await startHarness();
    const create = await h.api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'CRUD', slug: 'crud-wf', definition: WF }),
    });
    expect(create.status).toBe(201);
    const wf = (await create.json()) as { id: string; version: number };
    expect(wf.version).toBe(1);

    const got = (await (await h.api(`/api/workflows/${wf.id}`)).json()) as { id: string };
    expect(got.id).toBe(wf.id);

    const list = (await (await h.api('/api/workflows')).json()) as {
      workflows: { id: string }[];
    };
    expect(list.workflows.some((w) => w.id === wf.id)).toBe(true);

    const updated = (await (
      await h.api(`/api/workflows/${wf.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'CRUD v2', definition: WF }),
      })
    ).json()) as { version: number; name: string };
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('CRUD v2');

    const del = await h.api(`/api/workflows/${wf.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { status: string }).status).toBe('archived');
  });

  it('PUT with an invalid definition → 422 INVALID_DEFINITION before the proxy', async () => {
    h = await startHarness();
    const create = await h.api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'CRUD2', slug: 'crud-wf-2', definition: WF }),
    });
    const wf = (await create.json()) as { id: string };
    const res = await h.api(`/api/workflows/${wf.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        definition: { steps: [{ id: 'r', type: 'retry', max_attempts: 99, body: [] }] },
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_DEFINITION',
    );
  });

  it('validate endpoint returns issues + estimate without an upstream call', async () => {
    h = await startHarness();
    const ok = (await (
      await h.api('/api/workflows/validate', {
        method: 'POST',
        body: JSON.stringify({ definition: WF }),
      })
    ).json()) as { valid: boolean; estimate: { typicalCents: number } | null };
    expect(ok.valid).toBe(true);
    expect(ok.estimate?.typicalCents).toBe(20); // 1 task × 4 × 5¢

    const bad = (await (
      await h.api('/api/workflows/validate', {
        method: 'POST',
        body: JSON.stringify({ definition: { steps: [] } }),
      })
    ).json()) as { valid: boolean; estimate: unknown };
    expect(bad.valid).toBe(false);
    expect(bad.estimate).toBeNull();
  });

  it('starting a run from a stored workflow id reconciles to succeeded', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const create = await h.api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Stored', slug: 'stored-wf', definition: WF }),
    });
    const wf = (await create.json()) as { id: string };
    const start = await h.api(`/api/workflows/${wf.id}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        inputs: { x: 'go' },
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
      }),
    });
    expect(start.status).toBe(201);
    const run = (await start.json()) as { id: string; workflowId: string | null };
    expect(run.workflowId).toBe(wf.id);

    const finished = await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
      };
      return r.status === 'succeeded' ? r : undefined;
    });
    expect(finished).toBeTruthy();

    const list = (await (await h.api('/api/workflows/runs')).json()) as {
      runs: { id: string }[];
    };
    expect(list.runs.some((r) => r.id === run.id)).toBe(true);
  });

  it('cancels a queued/running workflow run', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const start = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 500,
        confirmCostCents: 500,
        definition: {
          steps: [
            { id: 'gate', type: 'human_approval', message: 'wait' },
            { id: 'ok', type: 'succeed' },
          ],
        },
      }),
    });
    const run = (await start.json()) as { id: string };
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
      };
      return r.status === 'awaiting_human' ? r : undefined;
    });
    const cancel = await h.api(`/api/workflows/runs/${run.id}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(cancel.status).toBe(200);
    await pollUntil(async () => {
      const r = (await (await h!.api(`/api/workflows/runs/${run.id}`)).json()) as {
        status: string;
      };
      return r.status === 'cancelled' ? r : undefined;
    });
  });

  it('ad-hoc workflow run without a definition → 400 BAD_REQUEST', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const res = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({ machineId, budgetCents: 100, confirmCostCents: 100 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });
});

describe('run list + filter + local-run edges', () => {
  it('lists runs and filters by status', async () => {
    h = await startHarness();
    const create = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'local list test' }),
    });
    const run = (await create.json()) as { id: string };

    const all = (await (await h.api('/api/runs?limit=50')).json()) as { runs: { id: string }[] };
    expect(all.runs.some((r) => r.id === run.id)).toBe(true);

    const running = (await (await h.api('/api/runs?status=running')).json()) as {
      runs: { status: string }[];
    };
    expect(running.runs.every((r) => r.status === 'running')).toBe(true);
    expect(running.runs.length).toBeGreaterThan(0);
  });

  it('cancel marks a local run cancelled and appends a status event', async () => {
    h = await startHarness();
    const create = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'local cancel test' }),
    });
    const run = (await create.json()) as { id: string };
    const cancel = await h.api(`/api/runs/${run.id}/cancel`, { method: 'POST', body: '{}' });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { status: string }).status).toBe('cancelled');

    const poll = (await (await h.api(`/api/runs/${run.id}/events.json?after=0`)).json()) as {
      events: { type: string; data: { status?: string } }[];
    };
    expect(poll.events.some((e) => e.type === 'status' && e.data.status === 'cancelled')).toBe(
      true,
    );
  });

  it('resuming a local run → 409 NOT_SUPPORTED', async () => {
    h = await startHarness();
    const create = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'local resume test' }),
    });
    const run = (await create.json()) as { id: string };
    const resume = await h.api(`/api/runs/${run.id}/resume`, { method: 'POST', body: '{}' });
    expect(resume.status).toBe(409);
    expect(((await resume.json()) as { error: { code: string } }).error.code).toBe('NOT_SUPPORTED');
  });

  it('PATCH /api/local-runs/:id updates status + cost + reason', async () => {
    h = await startHarness();
    const create = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'local patch test' }),
    });
    const run = (await create.json()) as { id: string };

    const awaiting = await h.api(`/api/local-runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'awaiting_human', reason: 'need approval' }),
    });
    expect(awaiting.status).toBe(200);
    const a = (await awaiting.json()) as { status: string; awaitingHumanReason: string | null };
    expect(a.status).toBe('awaiting_human');
    expect(a.awaitingHumanReason).toBe('need approval');

    const done = await h.api(`/api/local-runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'succeeded', costCents: 12 }),
    });
    const d = (await done.json()) as {
      status: string;
      costCents: number;
      finishedAt: string | null;
    };
    expect(d.status).toBe('succeeded');
    expect(d.costCents).toBe(12);
    expect(d.finishedAt).not.toBeNull();
  });

  it('appending events to an unknown local run → 404', async () => {
    h = await startHarness();
    const res = await h.api('/api/local-runs/r_missing/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'status', data: { status: 'running' } }] }),
    });
    expect(res.status).toBe(404);
  });

  it('appending an awaiting_human event surfaces a notification on the feed', async () => {
    h = await startHarness();
    const create = await h.api('/api/local-runs', {
      method: 'POST',
      body: JSON.stringify({ task: 'local awaiting test' }),
    });
    const run = (await create.json()) as { id: string };
    const append = await h.api(`/api/local-runs/${run.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{ type: 'awaiting_human', data: { reason: 'confirm please' } }],
      }),
    });
    expect(append.status).toBe(200);

    const userId = (h.built.db.sql.prepare('SELECT id FROM users LIMIT 1').get() as { id: string })
      .id;
    const notifications = h.built.db.eventsAfter('notification', userId, 0);
    expect(notifications.some((n) => n.type === 'run.awaiting_human')).toBe(true);
  });
});

describe('webhook receiver — workflow-run branch', () => {
  it('verifies a signed workflow.run delivery and reconciles state', async () => {
    h = await startHarness();
    const machineId = await createTestMachine(h);
    const start = await h.api('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({
        machineId,
        budgetCents: 200,
        confirmCostCents: 200,
        definition: WF,
      }),
    });
    const run = (await start.json()) as { id: string };
    // Wait for the workflow-run row to carry a webhook_secret.
    const row = await pollUntil(async () => {
      const r = h!.built.db.sql.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(run.id) as
        | { coasty_workflow_run_id: string; webhook_secret: string | null }
        | undefined;
      return r?.webhook_secret ? r : undefined;
    });

    const payload = JSON.stringify({
      event: 'workflow_run.succeeded',
      run: {
        id: row.coasty_workflow_run_id,
        object: 'workflow.run',
        status: 'succeeded',
        spent_cents: 15,
      },
    });
    const header = await signWebhookPayload({ secret: row.webhook_secret!, body: payload });
    const res = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Coasty-Signature': header },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { received: boolean }).received).toBe(true);
  });

  it('rejects a payload missing run/event with 400 BAD_REQUEST', async () => {
    h = await startHarness();
    const body = JSON.stringify({ nonsense: true });
    const header = await signWebhookPayload({ secret: 'whsec_x', body });
    const res = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Coasty-Signature': header },
      body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('missing signature header → 401', async () => {
    h = await startHarness();
    const res = await fetch(`${h.backendUrl}/webhooks/coasty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'run.succeeded', run: { id: 'run_x', status: 'succeeded' } }),
    });
    expect(res.status).toBe(401);
  });
});

describe('EventBus fan-out (unit)', () => {
  it('delivers to stream + user listeners and isolates broken subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const evt = (type: string): BusEvent => ({
      streamKind: 'run',
      streamId: 's1',
      seq: 1,
      type,
      data: {},
      userId: 'u1',
      createdAt: new Date().toISOString(),
    });

    const offStream = bus.subscribeStream('run', 's1', () => {
      throw new Error('broken stream subscriber');
    });
    const offStream2 = bus.subscribeStream('run', 's1', () => seen.push('stream'));
    const offUser = bus.subscribeUser('u1', () => seen.push('user'));
    const offUserBroken = bus.subscribeUser('u1', () => {
      throw new Error('broken user subscriber');
    });

    // A throwing subscriber must never break delivery to the others.
    expect(() => bus.publish(evt('status'))).not.toThrow();
    expect(seen).toContain('stream');
    expect(seen).toContain('user');

    offStream();
    offStream2();
    offUser();
    offUserBroken();

    // After unsubscribing the last listener, publishing is a no-op.
    seen.length = 0;
    bus.publish(evt('status'));
    expect(seen).toEqual([]);
  });
});
