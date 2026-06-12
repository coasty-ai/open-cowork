import { describe, expect, it, vi } from 'vitest';
import {
  CoastyApiError,
  CoastyClient,
  CoastyTimeoutError,
  type FetchLike,
  type RunEvent,
} from '../src/index';

const BASE = 'https://coasty.test/v1';
const KEY = 'sk-coasty-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A scripted fetch: returns queued responses in order; records every call. */
function scriptedFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const responder = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return responder();
  };
  return { fetchImpl, calls };
}

const json =
  (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

function client(
  fetchImpl: FetchLike,
  extra: Partial<ConstructorParameters<typeof CoastyClient>[0]> = {},
) {
  return new CoastyClient({
    baseUrl: BASE,
    apiKey: KEY,
    fetchImpl,
    retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0.5 },
    ...extra,
  });
}

describe('CoastyClient transport', () => {
  it('sends X-API-Key always; Content-Type only when a body is sent', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json({ models: [], cua_versions: [], action_types: [] }),
    ]);
    const c = client(fetchImpl);
    await c.models(); // GET — no body
    await c.parse('pyautogui.click(1,2)'); // POST — body
    expect(calls[0]!.headers['X-API-Key']).toBe(KEY);
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/models`);
    expect(calls[1]!.headers['Content-Type']).toBe('application/json');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({})]);
    const c = new CoastyClient({ baseUrl: `${BASE}///`, apiKey: KEY, fetchImpl });
    await c.models();
    expect(calls[0]!.url).toBe(`${BASE}/models`);
  });

  it('serializes query params and skips undefined ones', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json({ object: 'list', data: [], has_more: false }),
    ]);
    await client(fetchImpl).listRuns({ status: 'running' });
    expect(calls[0]!.url).toBe(`${BASE}/runs?status=running`);
  });

  it('passes the Idempotency-Key header on createRun', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ id: 'run_1', status: 'queued' })]);
    await client(fetchImpl).createRun(
      { machine_id: 'm_1', task: 'do it' },
      { idempotencyKey: 'order-4821' },
    );
    expect(calls[0]!.headers['Idempotency-Key']).toBe('order-4821');
    expect(calls[0]!.body).toMatchObject({ machine_id: 'm_1', task: 'do it' });
  });

  it('URL-encodes path ids', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({})]);
    await client(fetchImpl).getRun('run/../sneaky');
    expect(calls[0]!.url).toBe(`${BASE}/runs/run%2F..%2Fsneaky`);
  });

  it('maps the documented error envelope to CoastyApiError', async () => {
    const { fetchImpl } = scriptedFetch([
      json(
        {
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Operation needs 20 credits; you have 5.',
            type: 'billing_error',
            request_id: 'req_8f2c1e9a',
            suggestion: 'Top up at https://coasty.ai/credits',
            required: 20,
            balance: 5,
          },
        },
        402,
      ),
    ]);
    const err = await client(fetchImpl)
      .predict({ screenshot: 'x'.repeat(200), instruction: 'click' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoastyApiError);
    const apiErr = err as CoastyApiError;
    expect(apiErr.status).toBe(402);
    expect(apiErr.code).toBe('INSUFFICIENT_CREDITS');
    expect(apiErr.errorType).toBe('billing_error');
    expect(apiErr.requestId).toBe('req_8f2c1e9a');
    expect(apiErr.raw?.balance).toBe(5);
  });

  it('captures Retry-After header as retryAfterMs', async () => {
    const { fetchImpl } = scriptedFetch([
      json(
        {
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'busy',
            type: 'server_error',
            request_id: 'r',
          },
        },
        503,
        {
          'Retry-After': '7',
        },
      ),
    ]);
    const err = (await client(fetchImpl)
      .getRun('run_1')
      .catch((e: unknown) => e)) as CoastyApiError;
    // GET is retried; with maxAttempts 3 all attempts hit 503 then it throws
    expect(err.retryAfterMs).toBe(7000);
  });

  it('handles non-JSON error bodies gracefully', async () => {
    const { fetchImpl } = scriptedFetch([
      () => new Response('<html>gateway error</html>', { status: 502 }),
    ]);
    const err = (await client(fetchImpl)
      .predict({ screenshot: 'x'.repeat(200), instruction: 'c' })
      .catch((e: unknown) => e)) as CoastyApiError;
    expect(err).toBeInstanceOf(CoastyApiError);
    expect(err.status).toBe(502);
  });

  it('times out with CoastyTimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const never: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      const c = new CoastyClient({
        baseUrl: BASE,
        apiKey: KEY,
        fetchImpl: never,
        timeoutMs: 1000,
        retry: { maxAttempts: 1 }, // timeouts are retryable; a single attempt keeps fake timers simple
      });
      const promise = c.models().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1001);
      const err = await promise;
      expect(err).toBeInstanceOf(CoastyTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CoastyClient retry policy', () => {
  const error503 = () =>
    json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'down',
          type: 'server_error',
          request_id: 'r1',
        },
      },
      503,
    )();

  it('retries GET on 503 then succeeds', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => error503(),
      json({ id: 'run_1', status: 'running' }),
    ]);
    const run = await client(fetchImpl).getRun('run_1');
    expect(run).toMatchObject({ id: 'run_1' });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a POST without an Idempotency-Key', async () => {
    const { fetchImpl, calls } = scriptedFetch([() => error503()]);
    await expect(
      client(fetchImpl).createRun({ machine_id: 'm', task: 't' }),
    ).rejects.toBeInstanceOf(CoastyApiError);
    expect(calls).toHaveLength(1);
  });

  it('DOES retry a POST when an Idempotency-Key is provided', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => error503(),
      json({ id: 'run_2', status: 'queued' }),
    ]);
    const run = await client(fetchImpl).createRun(
      { machine_id: 'm', task: 't' },
      { idempotencyKey: 'k1' },
    );
    expect(run).toMatchObject({ id: 'run_2' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['Idempotency-Key']).toBe('k1');
  });

  it('never retries non-retryable errors (422)', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            type: 'validation_error',
            request_id: 'r',
          },
        },
        422,
      ),
    ]);
    await expect(client(fetchImpl).getRun('x')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(1);
  });

  it('DELETE is retried (idempotent by nature)', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => error503(),
      json({ status: 'ok', session_id: 's1' }),
    ]);
    const res = await client(fetchImpl).deleteSession('s1');
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(2);
  });
});

describe('CoastyClient SSE streaming', () => {
  function sseResponse(frames: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  /** Stream that delivers frames on the first read, then errors mid-stream
   * (erroring inside start() would discard the queued chunk entirely). */
  function brokenSseResponse(frames: string): Response {
    let pulled = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode(frames));
          } else {
            controller.error(new Error('connection reset'));
          }
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  it('yields parsed events and stops after done', async () => {
    const frames =
      'id: 1\nevent: status\ndata: {"status":"running"}\n\n' +
      'id: 2\nevent: step\ndata: {"steps_completed":1}\n\n' +
      'id: 3\nevent: done\ndata: {"status":"succeeded"}\n\n';
    const { fetchImpl, calls } = scriptedFetch([() => sseResponse(frames)]);
    const events: RunEvent[] = [];
    for await (const e of client(fetchImpl).streamRunEvents('run_1')) events.push(e);
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'status'],
      [2, 'step'],
      [3, 'done'],
    ]);
    expect(events[0]!.data).toEqual({ status: 'running' });
    expect(calls[0]!.headers['Accept']).toBe('text/event-stream');
    expect(calls[0]!.headers['Last-Event-ID']).toBeUndefined();
  });

  it('reconnects after a mid-stream drop with Last-Event-ID and no duplicates', async () => {
    const first = 'id: 1\nevent: status\ndata: {"s":1}\n\nid: 2\nevent: step\ndata: {"s":2}\n\n';
    const second = 'id: 2\nevent: step\ndata: {"s":2}\n\nid: 3\nevent: done\ndata: {"s":3}\n\n'; // overlap on 2
    const { fetchImpl, calls } = scriptedFetch([
      () => brokenSseResponse(first),
      () => sseResponse(second),
    ]);
    const events: RunEvent[] = [];
    for await (const e of client(fetchImpl).streamRunEvents('run_1', { sleep: async () => {} })) {
      events.push(e);
    }
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]); // overlap deduped, nothing lost
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['Last-Event-ID']).toBe('2');
  });

  it('resumes from a caller-provided lastEventId', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => sseResponse('id: 6\nevent: done\ndata: {}\n\n'),
    ]);
    const events: RunEvent[] = [];
    for await (const e of client(fetchImpl).streamRunEvents('run_1', { lastEventId: 5 }))
      events.push(e);
    expect(calls[0]!.headers['Last-Event-ID']).toBe('5');
    expect(events.map((e) => e.seq)).toEqual([6]);
  });

  it('throws a CoastyApiError for non-2xx stream responses', async () => {
    const { fetchImpl } = scriptedFetch([
      json(
        {
          error: {
            code: 'RUN_NOT_FOUND',
            message: 'nope',
            type: 'not_found_error',
            request_id: 'r',
          },
        },
        404,
      ),
    ]);
    const iterate = async () => {
      for await (const _e of client(fetchImpl).streamRunEvents('missing')) {
        // unreachable
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('stops on abort without throwing', async () => {
    const controller = new AbortController();
    const frames = 'id: 1\nevent: status\ndata: {}\n\n'; // stream ends without done → would reconnect
    const { fetchImpl } = scriptedFetch([() => sseResponse(frames)]);
    const events: RunEvent[] = [];
    for await (const e of client(fetchImpl).streamRunEvents('run_1', {
      signal: controller.signal,
      sleep: async () => {},
    })) {
      events.push(e);
      controller.abort();
    }
    expect(events).toHaveLength(1);
  });

  it('workflow run events use the workflows path', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => sseResponse('id: 1\nevent: done\ndata: {}\n\n'),
    ]);
    for await (const _e of client(fetchImpl).streamWorkflowRunEvents('wfr_9')) {
      // drain
    }
    expect(calls[0]!.url).toBe(`${BASE}/workflows/runs/wfr_9/events`);
  });
});

describe('CoastyClient endpoint coverage (paths + methods)', () => {
  it('hits the documented paths', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({})]);
    const c = client(fetchImpl);
    await c.predict({ screenshot: 'x'.repeat(200), instruction: 'i' });
    await c.createSession({});
    await c.sessionPredict('s1', { screenshot: 'x'.repeat(200), instruction: 'i' });
    await c.resetSession('s1');
    await c.getSession('s1');
    await c.listSessions();
    await c.deleteSession('s1');
    await c.ground({ screenshot: 'x'.repeat(200), element: 'button' });
    await c.parse('pyautogui.click(1,2)');
    await c.usage('2026-06');
    await c.createRun({ machine_id: 'm', task: 't' });
    await c.listRuns();
    await c.getRun('r1');
    await c.cancelRun('r1');
    await c.resumeRun('r1', { note: 'go' });
    await c.createWorkflow({ name: 'n', slug: 's', definition: { steps: [] } });
    await c.listWorkflows();
    await c.getWorkflow('wf1');
    await c.updateWorkflow('wf1', { name: 'n2' });
    await c.deleteWorkflow('wf1');
    await c.startWorkflowRun('wf1', { inputs: {} });
    await c.startAdhocWorkflowRun({ definition: { steps: [] } });
    await c.listWorkflowRuns({ workflow_id: 'wf1' });
    await c.getWorkflowRun('wfr1');
    await c.cancelWorkflowRun('wfr1');
    await c.resumeWorkflowRun('wfr1', { approved: true });
    await c.createMachine({ display_name: 'vm' });
    await c.listMachines();
    await c.getMachine('m1');
    await c.machinePricing();
    await c.startMachine('m1');
    await c.stopMachine('m1');
    await c.restartMachine('m1');
    await c.terminateMachine('m1');
    await c.patchMachineTtl('m1', 60);
    await c.snapshotMachine('m1');
    await c.machineScreenshot('m1');
    await c.machineConnection('m1');
    await c.machineAction('m1', { command: 'click', parameters: { x: 1, y: 2 } });
    await c.machineActionsBatch('m1', { steps: [{ command: 'click' }], stop_on_error: true });
    await c.machineBrowserOp('m1', 'navigate', { url: 'https://example.com' });
    await c.machineTerminal('m1', { command: 'ls' });
    await c.machineFileOp('m1', 'read', { path: '/tmp/x' });

    const seen = calls.map((call) => `${call.method} ${call.url.replace(BASE, '')}`);
    expect(seen).toEqual([
      'POST /predict',
      'POST /sessions',
      'POST /sessions/s1/predict',
      'POST /sessions/s1/reset',
      'GET /sessions/s1',
      'GET /sessions',
      'DELETE /sessions/s1',
      'POST /ground',
      'POST /parse',
      'GET /usage?period=2026-06',
      'POST /runs',
      'GET /runs',
      'GET /runs/r1',
      'POST /runs/r1/cancel',
      'POST /runs/r1/resume',
      'POST /workflows',
      'GET /workflows',
      'GET /workflows/wf1',
      'PUT /workflows/wf1',
      'DELETE /workflows/wf1',
      'POST /workflows/wf1/runs',
      'POST /workflows/runs',
      'GET /workflows/runs?workflow_id=wf1',
      'GET /workflows/runs/wfr1',
      'POST /workflows/runs/wfr1/cancel',
      'POST /workflows/runs/wfr1/resume',
      'POST /machines',
      'GET /machines',
      'GET /machines/m1',
      'GET /machines/pricing',
      'POST /machines/m1/start',
      'POST /machines/m1/stop',
      'POST /machines/m1/restart',
      'DELETE /machines/m1',
      'PATCH /machines/m1',
      'POST /machines/m1/snapshot',
      'GET /machines/m1/screenshot',
      'GET /machines/m1/connection',
      'POST /machines/m1/actions',
      'POST /machines/m1/actions/batch',
      'POST /machines/m1/browser/navigate',
      'POST /machines/m1/terminal',
      'POST /machines/m1/files/read',
    ]);
  });

  it('resume bodies match the docs: run {note}, workflow {approved, note}', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({})]);
    const c = client(fetchImpl);
    await c.resumeRun('r1', { note: 'solved captcha' });
    await c.resumeWorkflowRun('wfr1', { approved: false, note: 'rejected' });
    expect(calls[0]!.body).toEqual({ note: 'solved captcha' });
    expect(calls[1]!.body).toEqual({ approved: false, note: 'rejected' });
  });
});
