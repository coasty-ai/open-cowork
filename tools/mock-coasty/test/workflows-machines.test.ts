import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { call, createMachine, LIVE_KEY, mock, pollUntil, TEST_KEY } from './helpers';

let m: MockCoasty | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
});

const task = (id: string, text = 'do something', save?: string) => ({
  id,
  type: 'task',
  task: text,
  ...(save ? { save_as: save } : {}),
});

async function adhoc(definition: Record<string, unknown>, extra: Record<string, unknown> = {}, key = TEST_KEY) {
  const machineId = await createMachine(m!, key);
  return call(m!, '/v1/workflows/runs', {
    method: 'POST',
    key,
    body: { definition, machine_id: machineId, ...extra },
  });
}

async function getWfRun(id: string) {
  return (await call(m!, `/v1/workflows/runs/${id}`)).json() as Record<string, unknown>;
}

async function waitForStatus(id: string, status: string, timeoutMs = 6000) {
  return pollUntil(async () => {
    const run = await getWfRun(id);
    return run.status === status ? run : undefined;
  }, timeoutMs);
}

describe('workflow validation (documented limits)', () => {
  const expectInvalid = async (definition: unknown, fragment: string) => {
    const res = await call(m!, '/v1/workflows', {
      method: 'POST',
      body: { name: 'X', slug: `s-${Math.random().toString(36).slice(2, 8)}`, definition },
    });
    expect(res.statusCode).toBe(422);
    const details = (res.json() as { error: { details?: string[] } }).error.details ?? [];
    expect(details.join(' | ')).toContain(fragment);
  };

  it('rejects each documented violation with a pointed message', async () => {
    m = mock();
    await expectInvalid({ steps: [] }, 'non-empty');
    await expectInvalid({ steps: [{ id: 'a', type: 'teleport' }] }, 'unknown step type');
    await expectInvalid({ steps: [task('dup'), task('dup')] }, 'duplicate step id');
    await expectInvalid({ steps: [{ id: 'r', type: 'retry', max_attempts: 21, body: [task('t')] }] }, '1-20');
    await expectInvalid(
      { steps: [{ id: 'p', type: 'parallel', branches: Array.from({ length: 17 }, (_, i) => [task(`b${i}`)]) }] },
      'at most 16',
    );
    await expectInvalid(
      { steps: [{ id: 'p', type: 'parallel', branches: [[{ id: 'h', type: 'human_approval' }]] }] },
      'not allowed inside a parallel',
    );
    await expectInvalid({ steps: [task('t', 'x', 'inputs')] }, 'reserved namespace');
    await expectInvalid(
      { steps: [{ id: 'a', type: 'assert', condition: { op: 'regex', left: 1, right: 2 } }] },
      'unknown condition op',
    );
    await expectInvalid({ steps: [{ id: 'l', type: 'loop', body: [task('t')] }] }, 'exactly one of count | while');
    // depth > 8
    let nested: Record<string, unknown>[] = [task('leaf')];
    for (let i = 0; i < 8; i++) nested = [{ id: `l${i}`, type: 'loop', count: 1, body: nested }];
    await expectInvalid({ steps: nested }, '8 levels');
  });

  it('bad slug → 422; duplicate slug → 422', async () => {
    m = mock();
    const def = { steps: [task('t')] };
    const bad = await call(m, '/v1/workflows', { method: 'POST', body: { name: 'N', slug: 'Bad Slug!', definition: def } });
    expect(bad.statusCode).toBe(422);
    const ok = await call(m, '/v1/workflows', { method: 'POST', body: { name: 'N', slug: 'taken', definition: def } });
    expect(ok.statusCode).toBe(201);
    const dup = await call(m, '/v1/workflows', { method: 'POST', body: { name: 'N2', slug: 'taken', definition: def } });
    expect(dup.statusCode).toBe(422);
  });

  it('PUT bumps the version; DELETE archives', async () => {
    m = mock();
    const def = { steps: [task('t')] };
    const wf = (
      await call(m, '/v1/workflows', { method: 'POST', body: { name: 'V', slug: 'v-test', definition: def } })
    ).json() as { id: string; version: number; dsl_version: string };
    expect(wf.version).toBe(1);
    expect(wf.dsl_version).toBe('2026-06-01');
    const updated = (
      await call(m, `/v1/workflows/${wf.id}`, { method: 'PUT', body: { name: 'V2' } })
    ).json() as { version: number };
    expect(updated.version).toBe(2);
    const archived = (await call(m, `/v1/workflows/${wf.id}`, { method: 'DELETE' })).json() as { status: string };
    expect(archived.status).toBe('archived');
  });
});

describe('workflow execution', () => {
  it('task → assert → if/contains → succeed binds results and resolves output templates', async () => {
    m = mock();
    const res = await adhoc(
      {
        steps: [
          task('fetch', 'Read invoice {{inputs.order}}', 'invoice'),
          { id: 'check', type: 'assert', condition: { op: 'truthy', value: '{{invoice.passed}}' } },
          {
            id: 'branch',
            type: 'if',
            condition: { op: 'contains', left: '{{invoice.result}}', right: 'ord_42' },
            then: [{ id: 'yes', type: 'succeed', output: { summary: '{{invoice.result}}' } }],
            else: [{ id: 'no', type: 'fail', message: 'wrong order' }],
          },
        ],
      },
      { inputs: { order: 'ord_42' } },
    );
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const run = await waitForStatus(id, 'succeeded');
    expect((run.output as { summary: string }).summary).toContain('ord_42');
    expect(run.spent_cents).toBeGreaterThan(0); // task steps observable in spend
  });

  it('assert failure fails the run with the message', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        task('t', 'will MUST_FAIL', 'r'),
        { id: 'a', type: 'assert', condition: { op: 'truthy', value: '{{r.passed}}' }, message: 'task must pass' },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitForStatus(id, 'failed');
    expect(run.error).toMatchObject({ code: 'ASSERTION_FAILED', message: 'task must pass' });
  });

  it('human_approval: pauses with awaiting_step_id; approve continues; reject fails', async () => {
    m = mock();
    const definition = {
      steps: [
        { id: 'gate', type: 'human_approval', message: 'OK for {{inputs.who}}?' },
        { id: 'ok', type: 'succeed', output: { approved: true } },
      ],
    };
    // approve path
    const approveRes = await adhoc(definition, { inputs: { who: 'me' } });
    const approveId = (approveRes.json() as { id: string }).id;
    const paused = await waitForStatus(approveId, 'awaiting_human');
    expect(paused.awaiting_step_id).toBe('gate');
    expect(paused.awaiting_human_reason).toBe('OK for me?');
    const resume = await call(m, `/v1/workflows/runs/${approveId}/resume`, { method: 'POST', body: { approved: true } });
    expect(resume.statusCode).toBe(200);
    const done = await waitForStatus(approveId, 'succeeded');
    expect(done.output).toEqual({ approved: true });

    // reject path
    const rejectRes = await adhoc(definition, {});
    const rejectId = (rejectRes.json() as { id: string }).id;
    await waitForStatus(rejectId, 'awaiting_human');
    await call(m, `/v1/workflows/runs/${rejectId}/resume`, { method: 'POST', body: { approved: false, note: 'nope' } });
    const failed = await waitForStatus(rejectId, 'failed');
    expect(failed.error).toMatchObject({ code: 'APPROVAL_REJECTED' });

    // resume when not awaiting → 409
    const conflict = await call(m, `/v1/workflows/runs/${rejectId}/resume`, { method: 'POST', body: { approved: true } });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('NOT_AWAITING_HUMAN');
  });

  it('budget_cents guard → failed GUARD_EXCEEDED', async () => {
    m = mock({ defaultRunSteps: 4 }); // each task ≈ 20¢
    const res = await adhoc(
      { steps: [task('a'), task('b'), task('c')] },
      { budget_cents: 30 },
    );
    const id = (res.json() as { id: string }).id;
    const run = await waitForStatus(id, 'failed');
    expect(run.error).toMatchObject({ code: 'GUARD_EXCEEDED' });
    expect(run.spent_cents as number).toBeGreaterThan(30);
  });

  it('loop count consumes iterations; while + max_iterations guard trips GUARD_EXCEEDED', async () => {
    m = mock();
    const counted = await adhoc({
      steps: [{ id: 'l', type: 'loop', count: 3, body: [task('t', 'tick')] }],
    });
    const countedId = (counted.json() as { id: string }).id;
    const countedRun = await waitForStatus(countedId, 'succeeded');
    expect(countedRun.iterations_used).toBe(3);

    const spinning = await adhoc(
      {
        steps: [{ id: 'w', type: 'loop', while: { op: 'truthy', value: true }, body: [task('t', 'spin')] }],
      },
      { max_iterations: 2 },
    );
    const spinningId = (spinning.json() as { id: string }).id;
    const spinningRun = await waitForStatus(spinningId, 'failed');
    expect(spinningRun.error).toMatchObject({ code: 'GUARD_EXCEEDED' });
  });

  it('retry recovers a MUST_FAIL_ONCE task', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'r',
          type: 'retry',
          max_attempts: 3,
          body: [
            task('flaky', 'sometimes MUST_FAIL_ONCE', 'out'),
            { id: 'a', type: 'assert', condition: { op: 'truthy', value: '{{out.passed}}' } },
          ],
        },
        { id: 'ok', type: 'succeed' },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitForStatus(id, 'succeeded');
    expect(run.status).toBe('succeeded');
  });

  it('parallel branches bind both results', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'p',
          type: 'parallel',
          branches: [[task('left', 'left work', 'L')], [task('right', 'right work', 'R')]],
        },
        {
          id: 'check',
          type: 'assert',
          condition: {
            op: 'and',
            conditions: [
              { op: 'truthy', value: '{{L.passed}}' },
              { op: 'truthy', value: '{{R.passed}}' },
            ],
          },
        },
        { id: 'ok', type: 'succeed', output: { both: true } },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitForStatus(id, 'succeeded');
    expect(run.output).toEqual({ both: true });
  });

  it('saved workflow runs via POST /v1/workflows/{id}/runs and events stream is durable', async () => {
    m = mock();
    const wf = (
      await call(m, '/v1/workflows', {
        method: 'POST',
        body: { name: 'Saved', slug: 'saved-wf', definition: { steps: [task('t', 'go', 'r'), { id: 'ok', type: 'succeed' }] } },
      })
    ).json() as { id: string };
    const machineId = await createMachine(m);
    const res = await call(m, `/v1/workflows/${wf.id}/runs`, { method: 'POST', body: { machine_id: machineId } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string; workflow_id: string }).id;
    expect((res.json() as { workflow_id: string }).workflow_id).toBe(wf.id);
    await waitForStatus(id, 'succeeded');
    const types = m.state.eventsAfter(id, 0).map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types.at(-1)).toBe('done');
  });
});

describe('machines', () => {
  it('test keys get an instant running mch_test_*; live keys need the $0.20 gate', async () => {
    m = mock();
    const test = await call(m, '/v1/machines', { method: 'POST', body: { display_name: 'vm' } });
    const machine = (test.json() as { machine: { id: string; status: string; is_test: boolean } }).machine;
    expect(machine.id).toMatch(/^mch_test_/);
    expect(machine.status).toBe('running');
    expect(machine.is_test).toBe(true);
    await m.app.close();

    m = mock({ walletCents: 19 });
    const gated = await call(m, '/v1/machines', { method: 'POST', key: LIVE_KEY, body: { display_name: 'vm' } });
    expect(gated.statusCode).toBe(402);
    const body = gated.json() as { error: { required: number; balance: number } };
    expect(body.error.required).toBe(20);
    expect(body.error.balance).toBe(19);
  });

  it('lifecycle: stop→start ok; illegal transitions → 409 INVALID_STATE; terminate ends it', async () => {
    m = mock();
    const id = await createMachine(m);
    const badStart = await call(m, `/v1/machines/${id}/start`, { method: 'POST', body: {} });
    expect(badStart.statusCode).toBe(409); // already running
    expect((await call(m, `/v1/machines/${id}/stop`, { method: 'POST', body: {} })).statusCode).toBe(200);
    const badStop = await call(m, `/v1/machines/${id}/stop`, { method: 'POST', body: {} });
    expect(badStop.statusCode).toBe(409);
    expect((await call(m, `/v1/machines/${id}/start`, { method: 'POST', body: {} })).statusCode).toBe(200);
    expect((await call(m, `/v1/machines/${id}`, { method: 'DELETE' })).statusCode).toBe(200);
    expect((await call(m, `/v1/machines/${id}`)).statusCode).toBe(404);
  });

  it('PATCH ttl validation: 4 → 422; 0 clears; 60 sets', async () => {
    m = mock();
    const id = await createMachine(m);
    expect((await call(m, `/v1/machines/${id}`, { method: 'PATCH', body: { ttl_minutes: 4 } })).statusCode).toBe(422);
    expect(
      ((await call(m, `/v1/machines/${id}`, { method: 'PATCH', body: { ttl_minutes: 60 } })).json() as { ttl_minutes: number })
        .ttl_minutes,
    ).toBe(60);
    expect(
      ((await call(m, `/v1/machines/${id}`, { method: 'PATCH', body: { ttl_minutes: 0 } })).json() as { ttl_minutes: null })
        .ttl_minutes,
    ).toBeNull();
  });

  it('snapshot bills 1 credit on live keys', async () => {
    m = mock();
    const id = await createMachine(m, LIVE_KEY);
    const res = await call(m, `/v1/machines/${id}/snapshot`, { method: 'POST', key: LIVE_KEY, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-credits-charged']).toBe('1');
    expect((res.json() as { snapshot_id: string }).snapshot_id).toMatch(/^snap_/);
  });

  it('screenshot is a real PNG that differs between captures', async () => {
    m = mock();
    const id = await createMachine(m);
    const first = (await call(m, `/v1/machines/${id}/screenshot`)).json() as { image_b64: string; width: number };
    const second = (await call(m, `/v1/machines/${id}/screenshot`)).json() as { image_b64: string };
    const bytes = Buffer.from(first.image_b64, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(first.width).toBe(320);
    expect(first.image_b64.length).toBeGreaterThan(100);
    expect(second.image_b64).not.toBe(first.image_b64); // frames advance
  });

  it('connection details carry Cache-Control: no-store and a PEM', async () => {
    m = mock();
    const id = await createMachine(m);
    const res = await call(m, `/v1/machines/${id}/connection`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.json() as { ssh_private_key_pem: string }).ssh_private_key_pem).toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('actions: echo result; MOCK_ERROR fails; batch stop_on_error aborts; stopped machine → 409', async () => {
    m = mock();
    const id = await createMachine(m);
    const ok = await call(m, `/v1/machines/${id}/actions`, {
      method: 'POST',
      body: { command: 'click', parameters: { x: 1, y: 2 } },
    });
    expect((ok.json() as { success: boolean; result: { x: number } }).result.x).toBe(1);

    const batch = await call(m, `/v1/machines/${id}/actions/batch`, {
      method: 'POST',
      body: {
        steps: [{ command: 'click' }, { command: 'MOCK_ERROR' }, { command: 'type' }],
        stop_on_error: true,
      },
    });
    const batchBody = batch.json() as { completed_count: number; failed_count: number; aborted: boolean; results: unknown[] };
    expect(batchBody.aborted).toBe(true);
    expect(batchBody.failed_count).toBe(1);
    expect(batchBody.completed_count).toBe(1);
    expect(batchBody.results).toHaveLength(2); // third step never ran

    await call(m, `/v1/machines/${id}/stop`, { method: 'POST', body: {} });
    const blocked = await call(m, `/v1/machines/${id}/actions`, { method: 'POST', body: { command: 'click' } });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: { current_state: string } }).error.current_state).toBe('stopped');
  });

  it('terminal echoes; files write→read→edit→delete→404; browser op canned; pricing documented', async () => {
    m = mock();
    const id = await createMachine(m);
    const echo = await call(m, `/v1/machines/${id}/terminal`, { method: 'POST', body: { command: 'echo hello world' } });
    expect((echo.json() as { output: string; exit_code: number }).output).toBe('hello world');

    await call(m, `/v1/machines/${id}/files/write`, {
      method: 'POST',
      body: { parameters: { path: '/tmp/a.txt', content: 'alpha' } },
    });
    const read = await call(m, `/v1/machines/${id}/files/read`, { method: 'POST', body: { parameters: { path: '/tmp/a.txt' } } });
    expect((read.json() as { content: string }).content).toBe('alpha');
    await call(m, `/v1/machines/${id}/files/edit`, {
      method: 'POST',
      body: { parameters: { path: '/tmp/a.txt', old_text: 'alpha', new_text: 'beta' } },
    });
    expect(
      ((await call(m, `/v1/machines/${id}/files/read`, { method: 'POST', body: { parameters: { path: '/tmp/a.txt' } } })).json() as {
        content: string;
      }).content,
    ).toBe('beta');
    await call(m, `/v1/machines/${id}/files/delete`, { method: 'POST', body: { parameters: { path: '/tmp/a.txt' } } });
    expect(
      (await call(m, `/v1/machines/${id}/files/read`, { method: 'POST', body: { parameters: { path: '/tmp/a.txt' } } })).statusCode,
    ).toBe(404);

    const nav = await call(m, `/v1/machines/${id}/browser/navigate`, {
      method: 'POST',
      body: { parameters: { url: 'https://example.com' } },
    });
    expect((nav.json() as { success: boolean }).success).toBe(true);

    const pricing = (await call(m, '/v1/machines/pricing')).json() as {
      runtime_hourly_cents: { linux_running: number; windows_running: number; stopped: number };
    };
    expect(pricing.runtime_hourly_cents).toMatchObject({ linux_running: 5, windows_running: 9, stopped: 1 });
  });
});
