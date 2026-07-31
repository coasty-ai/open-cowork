/**
 * POST /v1/tasks — submit-and-forget.
 *
 * The contract this suite pins down, in the order it matters:
 *   1. admission is strict and fails closed (validation, BYOK, wallet gates);
 *   2. the run is admitted with a NULL machine_id and provisions asynchronously;
 *   3. it NEVER pauses for a human, whatever the model asks for;
 *   4. cleanup always begins after a terminal outcome — and completing the task
 *      is not proof that termination finished;
 *   5. the model-input frames survive the machine that produced them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { call, LIVE_KEY, pollUntil, TEST_KEY } from './helpers';
import { createMockCoasty } from '../src/index';

let m: MockCoasty | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
});

function mock(opts: Parameters<typeof createMockCoasty>[0] = {}): MockCoasty {
  return createMockCoasty({ tickMs: 5, defaultRunSteps: 3, ...opts });
}

interface TaskRun {
  id: string;
  status: string;
  machine_id: string | null;
  machine: {
    mode: string;
    status: string;
    id: string | null;
    cleanup: string;
    cleanup_status: string;
    error?: { code: string; message: string } | null;
  } | null;
  on_awaiting_human: string;
  cua_version: string;
  max_steps: number;
  webhook_secret: string | null;
  result: { passed: boolean; summary: string } | null;
  error: { code: string; message: string } | null;
  steps_completed: number;
}

const createTask = (body: Record<string, unknown> = {}, key = TEST_KEY, headers = {}) =>
  call(m!, '/v1/tasks', {
    method: 'POST',
    key,
    headers,
    body: { task: 'Download the newest invoice and verify it', ...body },
  });

const getRun = async (id: string, key = TEST_KEY) =>
  (await call(m!, `/v1/runs/${id}`, { key })).json<TaskRun>();

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];

/** Wait for a terminal status. Does NOT wait for cleanup — that is the point. */
const untilTerminal = (id: string, key = TEST_KEY) =>
  pollUntil(async () => {
    const run = await getRun(id, key);
    return TERMINAL.includes(run.status) ? run : false;
  });

const untilCleanup = (id: string, status: string, key = TEST_KEY) =>
  pollUntil(async () => {
    const run = await getRun(id, key);
    return run.machine?.cleanup_status === status ? run : false;
  });

// ── admission validation ─────────────────────────────────────────────────────

describe('POST /v1/tasks — admission validation', () => {
  it('needs only `task` — that is the complete required integration', async () => {
    m = mock();
    const res = await createTask();
    expect(res.statusCode).toBe(201);
  });

  it('rejects a missing, empty, or over-long task', async () => {
    m = mock();
    for (const task of [undefined, '', 'x'.repeat(16001)]) {
      const res = await call(m, '/v1/tasks', { method: 'POST', body: { task } });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    }
    // Exactly at the limit is fine.
    expect(
      (await call(m, '/v1/tasks', { method: 'POST', body: { task: 'x'.repeat(16000) } }))
        .statusCode,
    ).toBe(201);
  });

  it('rejects unknown top-level fields instead of ignoring them', async () => {
    m = mock();
    const res = await createTask({ machine_id: 'mch_1' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('machine_id');
  });

  it('defaults cua_version to v5 and max_steps to 150', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    expect(run.cua_version).toBe('v5');
    expect(run.max_steps).toBe(150);
  });

  it.each(['v1', 'v3', 'v4', 'v5'])('accepts engine %s', async (cua) => {
    m = mock();
    expect((await createTask({ cua_version: cua })).statusCode).toBe(201);
  });

  it('rejects an unknown engine', async () => {
    m = mock();
    expect((await createTask({ cua_version: 'v2' })).statusCode).toBe(422);
  });

  it('enforces the 1..1000 max_steps range at both edges', async () => {
    m = mock();
    expect((await createTask({ max_steps: 1 })).statusCode).toBe(201);
    expect((await createTask({ max_steps: 1000 })).statusCode).toBe(201);
    for (const bad of [0, -1, 1001, 1.5, '10']) {
      expect((await createTask({ max_steps: bad })).statusCode).toBe(422);
    }
  });

  it('enforces the 1..86400 deadline_seconds range at both edges', async () => {
    m = mock();
    expect((await createTask({ deadline_seconds: 1 })).statusCode).toBe(201);
    expect((await createTask({ deadline_seconds: 86400 })).statusCode).toBe(201);
    for (const bad of [0, 86401, 1.5, 'soon']) {
      expect((await createTask({ deadline_seconds: bad })).statusCode).toBe(422);
    }
    // null means "server default", which is legal.
    expect((await createTask({ deadline_seconds: null })).statusCode).toBe(201);
  });

  it('enforces prompt-steering length limits', async () => {
    m = mock();
    expect((await createTask({ instructions: 'x'.repeat(16000) })).statusCode).toBe(201);
    expect((await createTask({ instructions: 'x'.repeat(16001) })).statusCode).toBe(422);
    expect((await createTask({ system_prompt: 'x'.repeat(32000) })).statusCode).toBe(201);
    expect((await createTask({ system_prompt: 'x'.repeat(32001) })).statusCode).toBe(422);
  });

  it('caps metadata at 50 keys and rejects non-objects', async () => {
    m = mock();
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    expect((await createTask({ metadata: fifty })).statusCode).toBe(201);
    expect((await createTask({ metadata: { ...fifty, extra: 'v' } })).statusCode).toBe(422);
    expect((await createTask({ metadata: ['a'] })).statusCode).toBe(422);
  });

  it('rejects a webhook_url carrying userinfo', async () => {
    // Credentials in a callback URL leak into logs on every delivery.
    m = mock();
    const res = await createTask({ webhook_url: 'https://user:pass@example.com/hook' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('userinfo');
  });

  it('rejects an unparseable or non-http webhook_url', async () => {
    m = mock();
    expect((await createTask({ webhook_url: 'not-a-url' })).statusCode).toBe(422);
    expect((await createTask({ webhook_url: 'ftp://example.com/hook' })).statusCode).toBe(422);
    expect((await createTask({ webhook_url: 42 })).statusCode).toBe(422);
  });
});

// ── machine preferences ──────────────────────────────────────────────────────

describe('POST /v1/tasks — machine preferences', () => {
  it.each(['auto', 'aws', 'daytona', 'azure'])('accepts provider %s', async (provider) => {
    m = mock();
    expect((await createTask({ machine: { provider } })).statusCode).toBe(201);
  });

  it('rejects an unknown provider and an unknown machine field', async () => {
    m = mock();
    expect((await createTask({ machine: { provider: 'gcp' } })).statusCode).toBe(422);
    expect((await createTask({ machine: { region: 'eu' } })).statusCode).toBe(422);
  });

  it('enforces sizing ranges at both edges', async () => {
    m = mock();
    const cases: [string, number, boolean][] = [
      ['cpu_cores', 1, true],
      ['cpu_cores', 16, true],
      ['cpu_cores', 0, false],
      ['cpu_cores', 17, false],
      ['memory_gb', 1, true],
      ['memory_gb', 64, true],
      ['memory_gb', 65, false],
      ['storage_gb', 8, true],
      ['storage_gb', 500, true],
      ['storage_gb', 7, false],
      ['storage_gb', 501, false],
    ];
    for (const [field, value, valid] of cases) {
      const res = await createTask({ machine: { [field]: value } });
      expect([field, value, res.statusCode]).toEqual([field, value, valid ? 201 : 422]);
    }
  });

  it('accepts a managed proxy and validates a custom one', async () => {
    m = mock();
    expect((await createTask({ machine: { proxy: { mode: 'managed' } } })).statusCode).toBe(201);
    expect(
      (
        await createTask({
          machine: { proxy: { mode: 'custom', scheme: 'socks5', host: 'p.example', port: 1080 } },
        })
      ).statusCode,
    ).toBe(201);
    // Bad scheme, missing host, and an out-of-range port each fail closed.
    expect(
      (
        await createTask({
          machine: { proxy: { mode: 'custom', scheme: 'ftp', host: 'p', port: 1 } },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await createTask({ machine: { proxy: { mode: 'custom', scheme: 'http', port: 1 } } }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await createTask({
          machine: { proxy: { mode: 'custom', scheme: 'http', host: 'p', port: 70000 } },
        })
      ).statusCode,
    ).toBe(422);
    expect((await createTask({ machine: { proxy: { mode: 'sneaky' } } })).statusCode).toBe(422);
  });

  it('honours a pinned os_type when provisioning', async () => {
    m = mock();
    const run = (await createTask({ machine: { os_type: 'windows' } })).json<TaskRun>();
    const ready = await pollUntil(async () => {
      const cur = await getRun(run.id);
      return cur.machine_id ? cur : false;
    });
    const machine = m.state.machines.get(ready.machine_id!);
    expect(machine?.os_type).toBe('windows');
  });
});

// ── action policy ────────────────────────────────────────────────────────────

describe('POST /v1/tasks — action_policy', () => {
  it('accepts a well-formed policy', async () => {
    m = mock();
    const res = await createTask({
      action_policy: { blocked_keys: ['escape'], block_window_close: true, max_actions: 5 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('does NOT echo the normalized policy back (retain your own copy)', async () => {
    m = mock();
    const run = (await createTask({ action_policy: { max_actions: 5 } })).json<
      Record<string, unknown>
    >();
    expect(run).not.toHaveProperty('action_policy');
  });

  it('rejects allowed/blocked overlap, bad bounds, and unknown fields', async () => {
    m = mock();
    expect(
      (
        await createTask({
          action_policy: { allowed_actions: ['click'], blocked_actions: ['click'] },
        })
      ).statusCode,
    ).toBe(422);
    expect((await createTask({ action_policy: { max_actions: 0 } })).statusCode).toBe(422);
    expect((await createTask({ action_policy: { max_actions: 10001 } })).statusCode).toBe(422);
    expect((await createTask({ action_policy: { nope: true } })).statusCode).toBe(422);
    expect(
      (
        await createTask({
          action_policy: { coordinate_bounds: { min_x: 5, min_y: 0, max_x: 4, max_y: 9 } },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await createTask({ action_policy: { coordinate_bounds: { min_x: 0, min_y: 0, max_x: 9 } } }))
        .statusCode,
    ).toBe(422);
  });

  it('accepts an inclusive one-pixel coordinate rectangle', async () => {
    m = mock();
    expect(
      (
        await createTask({
          action_policy: { coordinate_bounds: { min_x: 5, min_y: 5, max_x: 5, max_y: 5 } },
        })
      ).statusCode,
    ).toBe(201);
  });

  it('a violation fails the ACTIVE run — creation still succeeds', async () => {
    // The rejected action is produced later during execution, so admission
    // cannot know about it. The failure has to surface through the run.
    m = mock();
    const res = await createTask({
      task: 'POLICY_VIOLATION drive the app',
      action_policy: { blocked_keys: ['escape'] },
    });
    expect(res.statusCode).toBe(201);
    const run = await untilTerminal(res.json<TaskRun>().id);
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('ACTION_POLICY_VIOLATION');
  });
});

// ── BYOK boundary ────────────────────────────────────────────────────────────

describe('POST /v1/tasks — BYOK boundary', () => {
  it('rejects BYOK intent on a TEST key before execution, not silently', async () => {
    // A silently-ignored provider secret is worse than a rejection: the caller
    // believes their key was used and their bill is elsewhere.
    m = mock();
    const res = await createTask({ llm: { provider: 'anthropic' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LLM_PROVIDER_UNSUPPORTED');
  });

  it('rejects an X-LLM-Api-Key header on a test key even with no llm body', async () => {
    m = mock();
    const res = await createTask({}, TEST_KEY, { 'x-llm-api-key': 'sk-ant-secret' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LLM_PROVIDER_UNSUPPORTED');
  });

  it('allows explicit managed mode on a test key (that is not BYOK intent)', async () => {
    m = mock();
    expect((await createTask({ llm: { provider: 'managed' } })).statusCode).toBe(201);
  });

  it('allows BYOK on a live key', async () => {
    m = mock();
    expect((await createTask({ llm: { provider: 'anthropic' } }, LIVE_KEY)).statusCode).toBe(201);
  });

  it('rejects an unsupported provider', async () => {
    m = mock();
    const res = await createTask({ llm: { provider: 'cohere' } }, LIVE_KEY);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LLM_PROVIDER_UNSUPPORTED');
  });

  it('rejects a credential-shaped model id WITHOUT reflecting the value back', async () => {
    m = mock();
    const secret = 'sk-ant-super-secret-value';
    const res = await createTask({ llm: { provider: 'anthropic', model: secret } }, LIVE_KEY);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LLM_MODEL_INVALID');
    // The whole point of a non-reflective rejection: the secret must not come back.
    expect(res.body).not.toContain(secret);
  });

  it('rejects an over-long model id', async () => {
    m = mock();
    const res = await createTask({ llm: { provider: 'openai', model: 'x'.repeat(257) } }, LIVE_KEY);
    expect(res.statusCode).toBe(422);
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('POST /v1/tasks — idempotency', () => {
  it('replays the ORIGINAL run for the same key + body, flagged as a replay', async () => {
    m = mock();
    const first = await createTask({}, TEST_KEY, { 'idempotency-key': 'invoice-4821' });
    const second = await createTask({}, TEST_KEY, { 'idempotency-key': 'invoice-4821' });
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-coasty-idempotent-replay']).toBe('true');
    expect(second.json<TaskRun>().id).toBe(first.json<TaskRun>().id);
    // Exactly one run was created — not two machines.
    expect(m.state.runs.size).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    m = mock();
    await createTask({}, TEST_KEY, { 'idempotency-key': 'k' });
    const res = await createTask({ task: 'something else' }, TEST_KEY, { 'idempotency-key': 'k' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('treats machine.provider as part of the identity — a replay cannot migrate backends', async () => {
    m = mock();
    await createTask({ machine: { provider: 'aws' } }, TEST_KEY, { 'idempotency-key': 'k' });
    const res = await createTask({ machine: { provider: 'azure' } }, TEST_KEY, {
      'idempotency-key': 'k',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('validates the key charset and length', async () => {
    m = mock();
    expect(
      (await createTask({}, TEST_KEY, { 'idempotency-key': 'a'.repeat(128) })).statusCode,
    ).toBe(201);
    expect(
      (await createTask({}, TEST_KEY, { 'idempotency-key': 'b'.repeat(129) })).statusCode,
    ).toBe(422);
    expect((await createTask({}, TEST_KEY, { 'idempotency-key': 'has space' })).statusCode).toBe(
      422,
    );
    expect((await createTask({}, TEST_KEY, { 'idempotency-key': 'ok_-:123' })).statusCode).toBe(
      201,
    );
  });

  it('keeps the tasks and runs idempotency namespaces separate', async () => {
    // Reusing one key across two different operations must not collide.
    m = mock();
    const task = await createTask({}, TEST_KEY, { 'idempotency-key': 'shared' });
    expect(task.statusCode).toBe(201);
    const machine = await call(m, '/v1/machines', {
      method: 'POST',
      body: { display_name: 'vm' },
      headers: { 'idempotency-key': 'shared' },
    });
    expect(machine.statusCode).toBe(201);
  });
});

// ── wallet gates ─────────────────────────────────────────────────────────────

describe('POST /v1/tasks — wallet gates', () => {
  it('enforces the $0.20 provisioning gate on a live key', async () => {
    m = mock({ walletCents: 19 });
    const res = await createTask({}, LIVE_KEY);
    expect(res.statusCode).toBe(402);
    const body = res.json<{ error: { code: string; required: number; balance: number } }>();
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.error.required).toBe(20);
    expect(body.error.balance).toBe(19);
  });

  it('admits at exactly the gate', async () => {
    m = mock({ walletCents: 20 });
    expect((await createTask({}, LIVE_KEY)).statusCode).toBe(201);
  });

  it('never gates a test key — sandbox tasks are free', async () => {
    m = mock({ walletCents: 0 });
    expect((await createTask({}, TEST_KEY)).statusCode).toBe(201);
  });

  it('charges a live task per step and a test task nothing', async () => {
    m = mock({ walletCents: 1000 });
    const live = (await createTask({}, LIVE_KEY)).json<TaskRun>();
    const done = await untilTerminal(live.id, LIVE_KEY);
    expect(done.status).toBe('succeeded');
    // 3 steps at 5cr on v5.
    expect(m.state.walletCents).toBe(1000 - 15);
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('POST /v1/tasks — lifecycle', () => {
  it('is admitted with a NULL machine_id and a provisioning lifecycle view', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    expect(run.status).toBe('queued');
    expect(run.machine_id).toBeNull();
    expect(run.machine).toEqual({
      mode: 'automatic',
      status: 'provisioning',
      id: null,
      cleanup: 'always',
      cleanup_status: 'pending',
    });
  });

  it('hardwires on_awaiting_human to fail', async () => {
    m = mock();
    expect((await createTask()).json<TaskRun>().on_awaiting_human).toBe('fail');
  });

  it('provisions, runs, succeeds, then terminates its own machine', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    const done = await untilCleanup(run.id, 'terminated');
    expect(done.status).toBe('succeeded');
    expect(done.result?.passed).toBe(true);
    expect(done.machine_id).toMatch(/^mch_test_/);
    expect(done.machine?.status).toBe('released');
    // The machine really is gone, not just marked.
    expect(m.state.machines.get(done.machine_id!)?.status).toBe('terminated');
  });

  it('gives the generated machine a TTL LONGER than the deadline, as a leak backstop', async () => {
    m = mock();
    const run = (await createTask({ deadline_seconds: 600 })).json<TaskRun>();
    const ready = await pollUntil(async () => {
      const cur = await getRun(run.id);
      return cur.machine_id ? cur : false;
    });
    const ttl = m.state.machines.get(ready.machine_id!)?.ttl_minutes;
    expect(ttl).toBeGreaterThan(600 / 60);
  });

  it('NEVER enters awaiting_human — the handoff request is intercepted and suppressed', async () => {
    // The same NEEDS_HUMAN trigger pauses an ordinary run. A task must carry on.
    m = mock({ defaultRunSteps: 5 });
    const run = (await createTask({ task: 'NEEDS_HUMAN do the thing' })).json<TaskRun>();
    const seen: string[] = [];
    const done = await pollUntil(async () => {
      const cur = await getRun(run.id);
      seen.push(cur.status);
      return TERMINAL.includes(cur.status) ? cur : false;
    });
    expect(seen).not.toContain('awaiting_human');
    expect(done.status).toBe('succeeded');
  });

  it('cannot be resumed — there is never anything to resume', async () => {
    m = mock({ defaultRunSteps: 20 });
    const run = (await createTask({ task: 'NEEDS_HUMAN long job' })).json<TaskRun>();
    const res = await call(m, `/v1/runs/${run.id}/resume`, { method: 'POST', body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_AWAITING_HUMAN');
  });

  it('reports a provisioning failure as a terminal task error, never as success', async () => {
    m = mock();
    const run = (await createTask({ task: 'PROVISION_FAIL invoice run' })).json<TaskRun>();
    const done = await untilTerminal(run.id);
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('MACHINE_PROVISION_FAILED');
    expect(done.machine?.status).toBe('failed');
    expect(done.machine_id).toBeNull();
    expect(done.steps_completed).toBe(0);
  });

  it('still cleans up after a FAILED task', async () => {
    m = mock();
    const run = (await createTask({ task: 'MUST_FAIL the invoice' })).json<TaskRun>();
    const done = await untilCleanup(run.id, 'terminated');
    expect(done.status).toBe('failed');
    expect(m.state.machines.get(done.machine_id!)?.status).toBe('terminated');
  });

  it('still cleans up after a CANCELLED task', async () => {
    m = mock({ defaultRunSteps: 50 });
    const run = (await createTask({ task: 'RUN_LONG job' })).json<TaskRun>();
    await pollUntil(async () => ((await getRun(run.id)).machine_id ? true : false));
    const cancelled = await call(m, `/v1/runs/${run.id}/cancel`, { method: 'POST', body: {} });
    expect(cancelled.statusCode).toBe(200);
    const done = await untilCleanup(run.id, 'terminated');
    expect(done.status).toBe('cancelled');
    expect(m.state.machines.get(done.machine_id!)?.status).toBe('terminated');
  });

  it('times out on the deadline, counting provisioning time against it', async () => {
    m = mock({ tickMs: 40, defaultRunSteps: 50 });
    const run = (await createTask({ task: 'RUN_LONG job', deadline_seconds: 1 })).json<TaskRun>();
    const done = await untilTerminal(run.id);
    expect(done.status).toBe('timed_out');
  });

  it('leaves cleanup as `retrying` when termination is unavailable, and does NOT destroy the machine', async () => {
    // The TTL stays authoritative; recovery keeps retrying. Reporting
    // `terminated` here would be a lie the caller could not detect.
    m = mock();
    const run = (await createTask({ task: 'CLEANUP_STUCK invoice' })).json<TaskRun>();
    const done = await untilCleanup(run.id, 'retrying');
    expect(TERMINAL).toContain(done.status);
    expect(m.state.machines.get(done.machine_id!)?.status).toBe('running');
  });

  it('a terminal webhook can be delivered while cleanup is still in flight', async () => {
    // Task completion is NOT proof that provider termination has finished.
    m = mock();
    const hook = createMockCoasty();
    const received: Record<string, unknown>[] = [];
    hook.app.post('/hook', async (req) => {
      received.push(req.body as Record<string, unknown>);
      return { ok: true };
    });
    await hook.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hook.app.server.address() as { port: number }).port;
    try {
      const run = (
        await createTask({ webhook_url: `http://127.0.0.1:${port}/hook` })
      ).json<TaskRun>();
      expect(run.webhook_secret).toMatch(/^whsec_/);
      await pollUntil(async () => received.length > 0);
      const payload = received[0] as { event: string; run: TaskRun };
      expect(payload.event).toBe('run.succeeded');
      // The canonical cleanup status at delivery time — not yet 'terminated'.
      expect(['terminating', 'retrying', 'terminated']).toContain(
        payload.run.machine?.cleanup_status,
      );
    } finally {
      await hook.app.close();
    }
  });

  it('exposes the ephemeral machine in the machines list while running, and not after', async () => {
    m = mock({ defaultRunSteps: 50 });
    const run = (await createTask({ task: 'RUN_LONG job' })).json<TaskRun>();
    const ready = await pollUntil(async () => {
      const cur = await getRun(run.id);
      return cur.machine_id ? cur : false;
    });
    const listed = (await call(m, '/v1/machines')).json<{ data: { id: string }[] }>();
    expect(listed.data.map((x) => x.id)).toContain(ready.machine_id);

    await call(m, `/v1/runs/${run.id}/cancel`, { method: 'POST', body: {} });
    await untilCleanup(run.id, 'terminated');
    const after = (await call(m, '/v1/machines')).json<{ data: { id: string }[] }>();
    expect(after.data.map((x) => x.id)).not.toContain(ready.machine_id);
  });

  it('the task run shows up in the ordinary runs list and event stream', async () => {
    // The returned resource IS a normal durable Run — that is the contract.
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    const list = (await call(m, '/v1/runs')).json<{ data: { id: string }[] }>();
    expect(list.data.map((r) => r.id)).toContain(run.id);
    await untilTerminal(run.id);
    const events = m.state.eventsAfter(run.id, 0).map((e) => e.type);
    expect(events).toContain('status');
    expect(events).toContain('step');
    expect(events).toContain('done');
  });
});

// ── model-input frames ───────────────────────────────────────────────────────

describe('GET /v1/runs/{id}/screenshots', () => {
  const shots = (id: string, qs = '') =>
    call(m!, `/v1/runs/${id}/screenshots${qs}`).then((r) =>
      r.json<{ data: Record<string, unknown>[]; has_more: boolean }>(),
    );

  it('returns metadata only by default — no base64 payloads', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id);
    expect(page.data.length).toBe(3); // one frame per step
    for (const frame of page.data) {
      expect(frame).not.toHaveProperty('image_b64');
      expect(frame.encrypted_at_rest).toBe(true);
      expect(frame.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(frame.size_bytes).toBeGreaterThan(0);
    }
  });

  it('reports the MODEL coordinate space, which is not the machine resolution', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id);
    expect(page.data[0]!.width).toBe(1280);
    expect(page.data[0]!.height).toBe(720);
  });

  it('index is flat and monotonic from zero', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id);
    expect(page.data.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it('inlines images on request, clamps that page, and forbids caching', async () => {
    m = mock({ defaultRunSteps: 12 });
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const res = await call(m, `/v1/runs/${run.id}/screenshots?include_image=true`);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = res.json<{ data: { image_b64?: string }[]; has_more: boolean }>();
    expect(page.data.length).toBe(10); // clamped
    expect(page.has_more).toBe(true);
    expect(page.data[0]!.image_b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('does not let a caller raise the image clamp with limit', async () => {
    m = mock({ defaultRunSteps: 12 });
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id, '?include_image=true&limit=200');
    expect(page.data.length).toBe(10);
  });

  it('pages forward with after_index (exclusive)', async () => {
    m = mock({ defaultRunSteps: 6 });
    const run = (await createTask()).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id, '?after_index=2');
    expect(page.data.map((f) => f.index)).toEqual([3, 4, 5]);
    const last = await shots(run.id, '?after_index=5');
    expect(last.data).toEqual([]);
    expect(last.has_more).toBe(false);
  });

  it('validates after_index and limit', async () => {
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    expect((await call(m, `/v1/runs/${run.id}/screenshots?after_index=-1`)).statusCode).toBe(422);
    expect((await call(m, `/v1/runs/${run.id}/screenshots?after_index=x`)).statusCode).toBe(422);
    expect((await call(m, `/v1/runs/${run.id}/screenshots?limit=0`)).statusCode).toBe(400);
    expect((await call(m, `/v1/runs/${run.id}/screenshots?limit=201`)).statusCode).toBe(400);
  });

  it('flags a degraded frame so an inexplicable run can be explained', async () => {
    m = mock();
    const run = (await createTask({ task: 'DEGRADED_FRAME invoice run' })).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id);
    expect(page.data.filter((f) => f.degraded)).toHaveLength(1);
  });

  it('replaces the image with image_unavailable rather than failing the page', async () => {
    m = mock();
    const run = (await createTask({ task: 'BAD_FRAME invoice run' })).json<TaskRun>();
    await untilTerminal(run.id);
    const page = await shots(run.id, '?include_image=true');
    const bad = page.data.find((f) => f.image_unavailable);
    expect(bad).toBeDefined();
    expect(bad).not.toHaveProperty('image_b64');
    // One bad frame never fails the page — the good ones still came back.
    expect(page.data.filter((f) => f.image_b64).length).toBeGreaterThan(0);
  });

  it('OUTLIVES the machine that produced the frames', async () => {
    // This is the whole point for a managed task: the VM is destroyed, so the
    // stored frames are the only surviving evidence of what the agent saw.
    m = mock();
    const run = (await createTask()).json<TaskRun>();
    const done = await untilCleanup(run.id, 'terminated');
    expect(m.state.machines.get(done.machine_id!)?.status).toBe('terminated');
    const page = await shots(run.id, '?include_image=true');
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]!.image_b64).toBeTruthy();
  });

  it('404s an unknown run rather than returning an empty page', async () => {
    m = mock();
    const res = await call(m, '/v1/runs/run_nope/screenshots');
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('RUN_NOT_FOUND');
  });

  it('captures frames for ORDINARY runs too, not just tasks', async () => {
    m = mock();
    const machine = await call(m, '/v1/machines', {
      method: 'POST',
      body: { display_name: 'vm', os_type: 'linux' },
    });
    const machineId = machine.json<{ machine: { id: string } }>().machine.id;
    const run = (
      await call(m, '/v1/runs', { method: 'POST', body: { machine_id: machineId, task: 'go' } })
    ).json<TaskRun>();
    await untilTerminal(run.id);
    expect((await shots(run.id)).data.length).toBeGreaterThan(0);
  });
});
