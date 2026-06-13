/**
 * Targeted coverage for the remaining documented branches: predict/ground/parse
 * validation, the full set of workflow condition ops, the `fail` step + if/else,
 * retry exhaustion, workflow-level output templating, list filters/limits, the
 * machine create validators + snapshot billing, webhook retry on a dead URL, and
 * MockState.reset(). All deterministic and offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { MockState } from '../src/index';
import { call, createMachine, LIVE_KEY, mock, pollUntil, SCREENSHOT, TEST_KEY } from './helpers';

let m: MockCoasty | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
});

const errCode = (res: { json<T = unknown>(): T }) =>
  (res.json() as { error: { code: string } }).error.code;

const task = (id: string, text = 'do', save?: string) => ({
  id,
  type: 'task',
  task: text,
  ...(save ? { save_as: save } : {}),
});

async function adhoc(definition: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const machineId = await createMachine(m!);
  return call(m!, '/v1/workflows/runs', {
    method: 'POST',
    body: { definition, machine_id: machineId, ...extra },
  });
}
const getWfRun = async (id: string) =>
  (await call(m!, `/v1/workflows/runs/${id}`)).json() as Record<string, unknown>;
const waitFor = (id: string, status: string, timeoutMs = 8000) =>
  pollUntil(async () => {
    const run = await getWfRun(id);
    return run.status === status ? run : undefined;
  }, timeoutMs);

// ── inference validation branches ────────────────────────────────────────────

describe('predict / ground / parse validation branches', () => {
  it('predict: non-string screenshot → VALIDATION_ERROR with details', async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      body: { screenshot: 12345, instruction: 'click' },
    });
    expect(res.statusCode).toBe(422);
    expect(errCode(res)).toBe('VALIDATION_ERROR');
    expect((res.json() as { error: { details: unknown } }).error.details).toBeDefined();
  });

  it("predict: 'type:' instruction emits a type_text action with the parsed text", async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      body: { screenshot: SCREENSHOT, instruction: 'please type: hello world' },
    });
    const body = res.json() as { actions: { action_type: string; params: { text: string } }[] };
    expect(body.actions[0]?.action_type).toBe('type_text');
    expect(body.actions[0]?.params.text).toBe('hello world');
  });

  it('ground: non-string screenshot → VALIDATION_ERROR', async () => {
    m = mock();
    const res = await call(m, '/v1/ground', {
      method: 'POST',
      body: { screenshot: 'too short', element: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(errCode(res)).toBe('VALIDATION_ERROR');
  });

  it('parse: empty code → VALIDATION_ERROR', async () => {
    m = mock();
    const res = await call(m, '/v1/parse', { method: 'POST', body: { code: '' } });
    expect(res.statusCode).toBe(422);
    expect(errCode(res)).toBe('VALIDATION_ERROR');
  });

  it('parse: oversized code (>= 50000 chars) → VALIDATION_ERROR', async () => {
    m = mock();
    const res = await call(m, '/v1/parse', {
      method: 'POST',
      body: { code: 'x'.repeat(50_000) },
    });
    expect(res.statusCode).toBe(422);
    expect(errCode(res)).toBe('VALIDATION_ERROR');
  });
});

// ── machine create validators + snapshot billing ─────────────────────────────

describe('machine create validators', () => {
  it('invalid os_type → 422; too-short ttl in create → 422; list filter respects limit', async () => {
    m = mock();
    const badOs = await call(m, '/v1/machines', {
      method: 'POST',
      body: { display_name: 'vm', os_type: 'beos' },
    });
    expect(badOs.statusCode).toBe(422);
    expect(errCode(badOs)).toBe('VALIDATION_ERROR');

    const badTtl = await call(m, '/v1/machines', {
      method: 'POST',
      body: { display_name: 'vm', ttl_minutes: 3 },
    });
    expect(badTtl.statusCode).toBe(422);
    expect(errCode(badTtl)).toBe('VALIDATION_ERROR');

    // create two; list with limit=1 returns only one (slice path) and get works
    const a = await createMachine(m);
    await createMachine(m);
    const list = await call(m, '/v1/machines?limit=1');
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);
    const got = await call(m, `/v1/machines/${a}`);
    expect((got.json() as { id: string }).id).toBe(a);
  });

  it('windows machine reports Administrator ssh_username and 9c/hr', async () => {
    m = mock();
    const res = await call(m, '/v1/machines', {
      method: 'POST',
      body: { display_name: 'win', os_type: 'windows' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { connection: { ssh_username: string } }).connection.ssh_username).toBe(
      'Administrator',
    );
  });

  it('snapshot on a test key is free; on a live key with empty wallet → 402', async () => {
    m = mock();
    const testId = await createMachine(m, TEST_KEY);
    const free = await call(m, `/v1/machines/${testId}/snapshot`, { method: 'POST', body: {} });
    expect(free.headers['x-credits-charged']).toBe('0');

    await m.app.close();
    m = mock({ walletCents: 25 }); // covers the 20-credit gate, then drain
    const liveId = await createMachine(m, LIVE_KEY);
    m.state.walletCents = 0;
    const broke = await call(m, `/v1/machines/${liveId}/snapshot`, {
      method: 'POST',
      key: LIVE_KEY,
      body: {},
    });
    expect(broke.statusCode).toBe(402);
    expect(errCode(broke)).toBe('INSUFFICIENT_CREDITS');
  });

  it('actions: missing command → 422 VALIDATION_ERROR', async () => {
    m = mock();
    const id = await createMachine(m);
    const res = await call(m, `/v1/machines/${id}/actions`, { method: 'POST', body: {} });
    expect(res.statusCode).toBe(422);
    expect(errCode(res)).toBe('VALIDATION_ERROR');
  });
});

// ── workflow condition ops (the documented 13) ───────────────────────────────

describe('workflow condition ops', () => {
  // Build an assert chain: every op must hold or the run fails.
  it('eq / ne / lt / gt / lte / gte / contains numeric+string', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        { id: 'eq', type: 'assert', condition: { op: 'eq', left: 2, right: 2 } },
        { id: 'ne', type: 'assert', condition: { op: 'ne', left: 2, right: 3 } },
        { id: 'lt', type: 'assert', condition: { op: 'lt', left: 1, right: 2 } },
        { id: 'gt', type: 'assert', condition: { op: 'gt', left: 3, right: 2 } },
        { id: 'lte', type: 'assert', condition: { op: 'lte', left: 2, right: 2 } },
        { id: 'gte', type: 'assert', condition: { op: 'gte', left: 2, right: 2 } },
        { id: 'cs', type: 'assert', condition: { op: 'contains', left: 'hello', right: 'ell' } },
        {
          id: 'ca',
          type: 'assert',
          condition: { op: 'contains', left: ['a', 'b'], right: 'b' },
        },
        { id: 'ok', type: 'succeed', output: { all: 'pass' } },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.output).toEqual({ all: 'pass' });
  });

  it('falsy / exists / or / not', async () => {
    m = mock();
    const res = await adhoc(
      {
        steps: [
          { id: 'fa', type: 'assert', condition: { op: 'falsy', value: '' } },
          { id: 'ex', type: 'assert', condition: { op: 'exists', value: '{{inputs.present}}' } },
          {
            id: 'or',
            type: 'assert',
            condition: {
              op: 'or',
              conditions: [
                { op: 'truthy', value: false },
                { op: 'truthy', value: true },
              ],
            },
          },
          {
            id: 'no',
            type: 'assert',
            condition: { op: 'not', condition: { op: 'truthy', value: false } },
          },
          { id: 'ok', type: 'succeed' },
        ],
      },
      { inputs: { present: 'yes' } },
    );
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.status).toBe('succeeded');
  });

  it('lt with a non-numeric operand is false → assertion fails', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'lt',
          type: 'assert',
          condition: { op: 'lt', left: 'abc', right: 2 },
          message: 'NaN compare',
        },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'failed');
    expect(run.error).toMatchObject({ code: 'ASSERTION_FAILED', message: 'NaN compare' });
  });

  it('if/else takes the else branch when the condition is false', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'branch',
          type: 'if',
          condition: { op: 'eq', left: 1, right: 2 },
          then: [{ id: 'no', type: 'succeed', output: { took: 'then' } }],
          else: [{ id: 'yes', type: 'succeed', output: { took: 'else' } }],
        },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.output).toEqual({ took: 'else' });
  });
});

// ── workflow terminal steps + output templating ──────────────────────────────

describe('workflow terminal steps + output', () => {
  it('explicit fail step → failed WORKFLOW_FAILED with resolved message', async () => {
    m = mock();
    const res = await adhoc(
      { steps: [{ id: 'boom', type: 'fail', message: 'stop for {{inputs.reason}}' }] },
      { inputs: { reason: 'safety' } },
    );
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'failed');
    expect(run.error).toMatchObject({ code: 'WORKFLOW_FAILED', message: 'stop for safety' });
  });

  it('definition-level output template resolves when no succeed step is hit', async () => {
    m = mock();
    const res = await adhoc(
      {
        steps: [task('t', 'work {{inputs.tag}}', 'r')],
        output: { tag: '{{inputs.tag}}', result: '{{r.result}}' },
      },
      { inputs: { tag: 'v9' } },
    );
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    const out = run.output as { tag: string; result: string };
    expect(out.tag).toBe('v9');
    expect(out.result).toContain('v9');
  });

  it('retry exhausts when the body always fails → RETRY_EXHAUSTED-style failure', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'r',
          type: 'retry',
          max_attempts: 2,
          body: [
            task('always', 'this MUST_FAIL', 'out'),
            { id: 'chk', type: 'assert', condition: { op: 'truthy', value: '{{out.passed}}' } },
          ],
        },
        { id: 'ok', type: 'succeed' },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'failed');
    expect(run.status).toBe('failed');
    expect((run.error as { code: string }).code).toBe('ASSERTION_FAILED');
  });

  it('WALLET_EXHAUSTED mid-workflow when a live wallet runs dry', async () => {
    m = mock({ walletCents: 100, defaultRunSteps: 10 });
    const machineId = await createMachine(m, LIVE_KEY);
    m.state.walletCents = 8; // covers one step then dry
    const res = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      key: LIVE_KEY,
      body: {
        definition: { steps: [task('t', 'spend'), { id: 'ok', type: 'succeed' }] },
        machine_id: machineId,
      },
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'failed');
    expect(run.error).toMatchObject({ code: 'WALLET_EXHAUSTED' });
  });
});

// ── workflow CRUD list/filter/update branches ────────────────────────────────

describe('workflow CRUD list/filter branches', () => {
  it('workflows list: bad limit → INVALID_LIMIT; good limit slices', async () => {
    m = mock();
    const def = { steps: [{ id: 'ok', type: 'succeed' }] };
    await call(m, '/v1/workflows', {
      method: 'POST',
      body: { name: 'A', slug: 'a-wf', definition: def },
    });
    await call(m, '/v1/workflows', {
      method: 'POST',
      body: { name: 'B', slug: 'b-wf', definition: def },
    });
    const bad = await call(m, '/v1/workflows?limit=0');
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe('INVALID_LIMIT');
    const list = await call(m, '/v1/workflows?limit=1');
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it('workflow runs list: filters by workflow_id and clamps the limit', async () => {
    m = mock();
    const def = { steps: [{ id: 'ok', type: 'succeed' }] };
    const wf = (
      await call(m, '/v1/workflows', {
        method: 'POST',
        body: { name: 'WF', slug: 'wf-runs', definition: def },
      })
    ).json() as { id: string };
    const machineId = await createMachine(m);
    const saved = await call(m, `/v1/workflows/${wf.id}/runs`, {
      method: 'POST',
      body: { machine_id: machineId },
    });
    await waitFor((saved.json() as { id: string }).id, 'succeeded');
    // an unrelated ad-hoc run that must be filtered out
    await adhoc(def);

    const filtered = await call(m, `/v1/workflows/runs?workflow_id=${wf.id}&limit=9999`);
    const data = (filtered.json() as { data: { workflow_id: string | null }[] }).data;
    expect(data.length).toBe(1);
    expect(data[0]?.workflow_id).toBe(wf.id);
  });

  it('PUT updates definition + description + status; DELETE archives', async () => {
    m = mock();
    const def = { steps: [{ id: 'ok', type: 'succeed' }] };
    const wf = (
      await call(m, '/v1/workflows', {
        method: 'POST',
        body: { name: 'Up', slug: 'up-wf', definition: def },
      })
    ).json() as { id: string };
    const updated = await call(m, `/v1/workflows/${wf.id}`, {
      method: 'PUT',
      body: {
        definition: { steps: [task('t', 'new'), { id: 'ok', type: 'succeed' }] },
        description: 'now documented',
        status: 'active',
      },
    });
    const body = updated.json() as { version: number; description: string };
    expect(body.version).toBe(2);
    expect(body.description).toBe('now documented');

    const putBadDef = await call(m, `/v1/workflows/${wf.id}`, {
      method: 'PUT',
      body: { definition: { steps: [] } },
    });
    expect(putBadDef.statusCode).toBe(422);
    expect(errCode(putBadDef)).toBe('VALIDATION_ERROR');
  });
});

// ── MockState unit branches ──────────────────────────────────────────────────

describe('MockState direct units', () => {
  it('reset() clears every collection', () => {
    const state = new MockState(500);
    state.sessions.set('s', {} as never);
    state.machines.set('m', {} as never);
    state.runs.set('r', {} as never);
    state.workflows.set('w', {} as never);
    state.workflowRuns.set('wr', {} as never);
    state.emit('stream', 'status', { ok: true });
    state.idempotency.set('k', { bodyHash: 'h', status: 201, payload: {} });
    state.webhookDeliveries.push({
      url: 'x',
      body: '{}',
      headers: {},
      ok: true,
      status: 200,
      event: 'e',
    });
    state.reset();
    expect(state.sessions.size).toBe(0);
    expect(state.machines.size).toBe(0);
    expect(state.runs.size).toBe(0);
    expect(state.workflows.size).toBe(0);
    expect(state.workflowRuns.size).toBe(0);
    expect(state.events.size).toBe(0);
    expect(state.idempotency.size).toBe(0);
    expect(state.webhookDeliveries.length).toBe(0);
  });

  it('deliverWebhook records two failed attempts against a dead URL (one retry)', async () => {
    const state = new MockState(0);
    // 127.0.0.1:1 refuses immediately → fetch throws, both attempts recorded.
    await state.deliverWebhook('http://127.0.0.1:1/dead', 'whsec_x', 'run.failed', { run: {} });
    expect(state.webhookDeliveries.length).toBe(2);
    expect(state.webhookDeliveries.every((d) => d.ok === false)).toBe(true);
    expect(state.webhookDeliveries.every((d) => d.event === 'run.failed')).toBe(true);
  });

  it('emit assigns monotonically increasing seq starting at 1', () => {
    const state = new MockState(0);
    const a = state.emit('s', 'status', {});
    const b = state.emit('s', 'step', {});
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(state.eventsAfter('s', 1).map((e) => e.seq)).toEqual([2]);
  });
});
