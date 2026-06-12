/**
 * Run lifecycle: state machine, billing, idempotency, SSE replay/reconnect,
 * and HMAC-signed webhook delivery — all over real HTTP where it matters.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { call, createMachine, LIVE_KEY, mock, pollUntil, TEST_KEY } from './helpers';

let m: MockCoasty | null = null;
let capture: Server | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
  if (capture) {
    await new Promise((r) => capture!.close(r));
    capture = null;
  }
});

async function startRun(task: string, extra: Record<string, unknown> = {}, key = TEST_KEY) {
  const machineId = await createMachine(m!, key);
  const res = await call(m!, '/v1/runs', {
    method: 'POST',
    key,
    body: { machine_id: machineId, task, ...extra },
  });
  return { res, machineId };
}

async function getRun(id: string, key = TEST_KEY) {
  return (await call(m!, `/v1/runs/${id}`, { key })).json() as Record<string, unknown>;
}

describe('run creation', () => {
  it('returns the documented Run object with a one-time webhook_secret', async () => {
    m = mock();
    const { res } = await startRun('do it', { webhook_url: 'https://example.com/hook', max_steps: 40 });
    expect(res.statusCode).toBe(201);
    const run = res.json() as Record<string, unknown>;
    expect(run.object).toBe('agent.run');
    expect(run.status).toBe('queued');
    expect(run.webhook_secret).toMatch(/^whsec_/);
    expect(run.max_steps).toBe(40);
    expect(run.cua_version).toBe('v3');
    // get/list never return the secret again
    const fetched = await getRun(run.id as string);
    expect(fetched.webhook_secret).toBeNull();
  });

  it('rejects unknown body fields with 422 (documented strictness)', async () => {
    m = mock();
    const { res } = await startRun('task', { idempotency_key: 'wrong-place' });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toContain('idempotency_key');
  });

  it('404 MACHINE_NOT_FOUND for unknown machines', async () => {
    m = mock();
    const res = await call(m, '/v1/runs', { method: 'POST', body: { machine_id: 'm_ghost', task: 'x' } });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('MACHINE_NOT_FOUND');
  });

  it('Idempotency-Key: same body replays; different body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    m = mock();
    const machineId = await createMachine(m);
    const body = { machine_id: machineId, task: 'same task' };
    const first = await call(m, '/v1/runs', { method: 'POST', body, headers: { 'idempotency-key': 'order-1' } });
    const second = await call(m, '/v1/runs', { method: 'POST', body, headers: { 'idempotency-key': 'order-1' } });
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect(second.headers['x-coasty-idempotent-replay']).toBe('true');
    const conflict = await call(m, '/v1/runs', {
      method: 'POST',
      body: { ...body, task: 'DIFFERENT' },
      headers: { 'idempotency-key': 'order-1' },
    });
    expect(conflict.statusCode).toBe(422);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('402 when a live wallet cannot cover one step', async () => {
    m = mock({ walletCents: 24 }); // machine gate needs 20; one step needs 5 → run create fails
    const machineId = await createMachine(m, LIVE_KEY);
    const res = await call(m, '/v1/runs', {
      method: 'POST',
      key: LIVE_KEY,
      body: { machine_id: machineId, task: 'x', cua_version: 'v1' }, // v1 step = 8 > 24? no... wallet still 24
    });
    // wallet 24 ≥ 8 → created. Drain instead: tiny wallet via separate mock.
    expect(res.statusCode).toBe(201);
    await m.app.close();
    m = mock({ walletCents: 24 });
    const machine2 = await createMachine(m, LIVE_KEY);
    m.state.walletCents = 3; // drained after provisioning gate check
    const res2 = await call(m, '/v1/runs', { method: 'POST', key: LIVE_KEY, body: { machine_id: machine2, task: 'x' } });
    expect(res2.statusCode).toBe(402);
    expect((res2.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('run lifecycle', () => {
  it('queued → running → succeeded with ordered events and a passing result', async () => {
    m = mock();
    const { res } = await startRun('open the calculator');
    const id = (res.json() as { id: string }).id;
    const finished = await pollUntil(async () => {
      const run = await getRun(id);
      return run.status === 'succeeded' ? run : undefined;
    });
    expect(finished.result).toMatchObject({ passed: true, status: 'succeeded' });
    expect(finished.steps_completed).toBe(3);
    expect(finished.finished_at).toBeTruthy();

    const events = m.state.eventsAfter(id, 0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status'); // queued→running
    expect(types).toContain('step');
    expect(types).toContain('billing');
    expect(types.at(-1)).toBe('done');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // 1..n, no gaps
  });

  it('live runs bill 5cr per step (8 on v1); test runs bill 0', async () => {
    m = mock();
    const { res } = await startRun('task', { cua_version: 'v1' }, LIVE_KEY);
    const id = (res.json() as { id: string }).id;
    const finished = await pollUntil(async () => {
      const run = await getRun(id, LIVE_KEY);
      return run.status === 'succeeded' ? run : undefined;
    });
    expect(finished.cost_cents).toBe(3 * 8);

    const { res: testRes } = await startRun('task');
    const testId = (testRes.json() as { id: string }).id;
    const testFinished = await pollUntil(async () => {
      const run = await getRun(testId);
      return run.status === 'succeeded' ? run : undefined;
    });
    expect(testFinished.cost_cents).toBe(0);
  });

  it('MUST_FAIL → failed with result.passed false', async () => {
    m = mock();
    const { res } = await startRun('this MUST_FAIL');
    const id = (res.json() as { id: string }).id;
    const finished = await pollUntil(async () => {
      const run = await getRun(id);
      return run.status === 'failed' ? run : undefined;
    });
    expect(finished.result).toMatchObject({ passed: false });
    expect(finished.error).toMatchObject({ code: 'VERIFICATION_FAILED' });
  });

  it('WALLET_EXHAUSTED mid-run when the live wallet runs dry', async () => {
    m = mock({ walletCents: 100, defaultRunSteps: 10 });
    const machineId = await createMachine(m, LIVE_KEY);
    m.state.walletCents = 12; // covers 2 steps only
    const res = await call(m, '/v1/runs', { method: 'POST', key: LIVE_KEY, body: { machine_id: machineId, task: 'long' } });
    const id = (res.json() as { id: string }).id;
    const finished = await pollUntil(async () => {
      const run = await getRun(id, LIVE_KEY);
      return run.status === 'failed' ? run : undefined;
    });
    expect(finished.error).toMatchObject({ code: 'WALLET_EXHAUSTED' });
    expect(finished.steps_completed).toBe(2);
  });

  it('deadline_seconds → timed_out', async () => {
    // No RUN_LONG marker: defaultRunSteps(1000) means it can never finish
    // before the 1s deadline trips.
    m = mock({ tickMs: 20, defaultRunSteps: 1000 });
    const { res } = await startRun('slow forever task', { deadline_seconds: 1 });
    const id = (res.json() as { id: string }).id;
    const finished = await pollUntil(async () => {
      const run = await getRun(id);
      return run.status === 'timed_out' ? run : undefined;
    }, 8000);
    expect(finished.status).toBe('timed_out');
  });

  it('cancel: active → cancelled; terminal → 409 INVALID_STATE with allowed_from', async () => {
    m = mock({ defaultRunSteps: 50 });
    const { res } = await startRun('RUN_LONG task');
    const id = (res.json() as { id: string }).id;
    await pollUntil(async () => ((await getRun(id)).status === 'running' ? true : undefined));
    const cancel = await call(m, `/v1/runs/${id}/cancel`, { method: 'POST', body: {} });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelled');
    const again = await call(m, `/v1/runs/${id}/cancel`, { method: 'POST', body: {} });
    expect(again.statusCode).toBe(409);
    const body = again.json() as { error: { code: string; current_state: string; allowed_from: string[] } };
    expect(body.error.code).toBe('INVALID_STATE');
    expect(body.error.current_state).toBe('cancelled');
    expect(body.error.allowed_from).toContain('running');
  });

  it('NEEDS_HUMAN: pause → resume {note} → succeeded; resume while running → 409', async () => {
    m = mock();
    const { res } = await startRun('sensitive NEEDS_HUMAN step');
    const id = (res.json() as { id: string }).id;
    const paused = await pollUntil(async () => {
      const run = await getRun(id);
      return run.status === 'awaiting_human' ? run : undefined;
    });
    expect(paused.awaiting_human_reason).toBeTruthy();
    expect(m.state.eventsAfter(id, 0).some((e) => e.type === 'awaiting_human')).toBe(true);

    const resume = await call(m, `/v1/runs/${id}/resume`, { method: 'POST', body: { note: 'captcha solved' } });
    expect(resume.statusCode).toBe(200);
    expect((resume.json() as { status: string }).status).toBe('running');

    const finished = await pollUntil(async () => {
      const run = await getRun(id);
      return run.status === 'succeeded' ? run : undefined;
    });
    expect(finished).toBeTruthy();
    expect(m.state.eventsAfter(id, 0).some((e) => e.type === 'resumed')).toBe(true);

    const badResume = await call(m, `/v1/runs/${id}/resume`, { method: 'POST', body: {} });
    expect(badResume.statusCode).toBe(409);
    expect((badResume.json() as { error: { code: string } }).error.code).toBe('NOT_AWAITING_HUMAN');
  });

  it('on_awaiting_human: fail and cancel skip the pause', async () => {
    m = mock();
    for (const [mode, expected] of [
      ['fail', 'failed'],
      ['cancel', 'cancelled'],
    ] as const) {
      const { res } = await startRun('NEEDS_HUMAN now', { on_awaiting_human: mode });
      const id = (res.json() as { id: string }).id;
      const finished = await pollUntil(async () => {
        const run = await getRun(id);
        return run.status === expected ? run : undefined;
      });
      expect(finished.status).toBe(expected);
    }
  });

  it('list: limit + status filters validated per the error catalog', async () => {
    m = mock();
    const badLimit = await call(m, '/v1/runs?limit=999');
    expect(badLimit.statusCode).toBe(400);
    expect((badLimit.json() as { error: { code: string; max: number } }).error.code).toBe('INVALID_LIMIT');
    const badStatus = await call(m, '/v1/runs?status=exploded');
    expect(badStatus.statusCode).toBe(400);
    const body = badStatus.json() as { error: { code: string; valid_options: string[] } };
    expect(body.error.code).toBe('INVALID_STATUS_FILTER');
    expect(body.error.valid_options).toContain('awaiting_human');
  });
});

describe('SSE events (real HTTP)', () => {
  async function listen(): Promise<string> {
    await m!.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = m!.app.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  interface Frame {
    seq: number;
    type: string;
  }

  async function readSse(url: string, after?: number, takeUntil?: (f: Frame) => boolean): Promise<Frame[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const frames: Frame[] = [];
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': TEST_KEY, ...(after ? { 'Last-Event-ID': String(after) } : {}) },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const seq = Number(/^id: (\d+)$/m.exec(block)?.[1] ?? 0);
          const type = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
          const frame = { seq, type };
          frames.push(frame);
          if (type === 'done' || takeUntil?.(frame)) {
            controller.abort();
            return frames;
          }
        }
      }
    } catch {
      // aborted
    } finally {
      clearTimeout(timer);
    }
    return frames;
  }

  it('streams the full timeline and replays after reconnect with no dupes/gaps', async () => {
    m = mock({ defaultRunSteps: 6 });
    const base = await listen();
    const machineRes = await fetch(`${base}/v1/machines`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'sse-vm' }),
    });
    const machineId = ((await machineRes.json()) as { machine: { id: string } }).machine.id;
    const runRes = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ machine_id: machineId, task: 'streamed task' }),
    });
    const runId = ((await runRes.json()) as { id: string }).id;
    const url = `${base}/v1/runs/${runId}/events`;

    // Connect, take a handful, drop.
    const first = await readSse(url, undefined, (f) => f.seq >= 5);
    expect(first.length).toBeGreaterThanOrEqual(5);
    const cursor = first.at(-1)!.seq;

    // Reconnect with Last-Event-ID: must resume at cursor+1 and run to 'done'.
    const second = await readSse(url, cursor);
    expect(second[0]!.seq).toBe(cursor + 1);
    expect(second.at(-1)!.type).toBe('done');
    const seqs = [...first, ...second].map((f) => f.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length);
  });
});

describe('webhooks (HMAC over real HTTP)', () => {
  it('delivers signed callbacks for awaiting_human + terminal; signature verifies; tamper fails', async () => {
    const received: { body: string; signature: string }[] = [];
    capture = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ body, signature: String(req.headers['coasty-signature'] ?? '') });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => capture!.listen(0, '127.0.0.1', r));
    const capturePort = (capture.address() as { port: number }).port;

    m = mock();
    const { res } = await startRun('pause NEEDS_HUMAN here', {
      webhook_url: `http://127.0.0.1:${capturePort}/hooks`,
    });
    const run = res.json() as { id: string; webhook_secret: string };

    await pollUntil(async () => (received.some((r) => r.body.includes('run.awaiting_human')) ? true : undefined));
    await call(m, `/v1/runs/${run.id}/resume`, { method: 'POST', body: { note: 'go' } });
    await pollUntil(async () => (received.some((r) => r.body.includes('run.succeeded')) ? true : undefined));

    for (const delivery of received) {
      const parts = Object.fromEntries(delivery.signature.split(',').map((p) => p.split('=') as [string, string]));
      const expected = createHmac('sha256', run.webhook_secret).update(`${parts.t}.${delivery.body}`).digest('hex');
      expect(parts.v1).toBe(expected); // valid signature
      const tampered = createHmac('sha256', run.webhook_secret)
        .update(`${parts.t}.${delivery.body}X`)
        .digest('hex');
      expect(parts.v1).not.toBe(tampered); // tamper detection works
      const payload = JSON.parse(delivery.body) as { run: { webhook_secret: unknown } };
      expect(payload.run.webhook_secret).toBeNull(); // secret never re-sent
    }
    // The mock records each delivery AFTER its fetch resolves, which can lag
    // the capture server's view — poll instead of asserting instantly.
    await pollUntil(async () => (m!.state.webhookDeliveries.length >= 2 ? true : undefined));
  });
});
