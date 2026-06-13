import { describe, expect, it, vi } from 'vitest';
import type { AgentLoopEvent, CuaAction, SessionPredictResponse } from '@open-cowork/core';
import type { Executor } from '@open-cowork/executor';
import { LocalRunManager, type BackendRunEvent } from '../src/localRuns';

// ── fakes ─────────────────────────────────────────────────────────────────────

const CLICK: CuaAction = { action_type: 'click', params: { x: 10, y: 20 } };
const TYPE: CuaAction = { action_type: 'type_text', params: { text: 'hi' } };

function predictResponse(partial: Partial<SessionPredictResponse>): SessionPredictResponse {
  return {
    request_id: 'req_1',
    session_id: 'sess_1',
    step: 0,
    actions: [],
    reasoning: null,
    status: 'continue',
    usage: { credits_charged: 4, cost_cents: 4 },
    ...partial,
  };
}

interface FakeExecutorOpts {
  failExecute?: boolean;
  failScreenshot?: boolean;
}

function fakeExecutor(opts: FakeExecutorOpts = {}) {
  const executed: string[] = [];
  const state = { disposed: false };
  const executor: Executor = {
    kind: 'local',
    async screenshot() {
      if (opts.failScreenshot) throw new Error('capture daemon crashed');
      return { base64: 'A'.repeat(200), width: 1280, height: 720 };
    },
    async execute(action) {
      if (opts.failExecute) throw new Error('input blocked');
      executed.push(action.action_type);
    },
    async dimensions() {
      return { width: 1280, height: 720 };
    },
    async dispose() {
      state.disposed = true;
    },
  };
  return { executor, executed, state };
}

interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

interface FakeBackendOpts {
  /** Scripted predict responses; the last entry repeats forever. */
  predictScript?: SessionPredictResponse[];
}

function fakeBackend(opts: FakeBackendOpts = {}) {
  const requests: RecordedRequest[] = [];
  const script = opts.predictScript ?? [
    predictResponse({ actions: [CLICK], reasoning: 'click the icon' }),
    predictResponse({ status: 'done', reasoning: 'task complete' }),
  ];
  let predictCalls = 0;
  // The backend run-status the cancel watcher polls (a cross-device cancel
  // flips this to 'cancelled').
  let runStatus = 'running';

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });

    if (method === 'POST' && path === '/api/local-runs')
      return json({ id: 'r_local1', status: 'running' }, 201);
    if (method === 'POST' && path === '/api/proxy/sessions') {
      return json({
        session_id: 'sess_1',
        cua_version: 'v3',
        screen_size: `${body.screenWidth}x${body.screenHeight}`,
        created_at: '2026-06-11T00:00:00Z',
        expires_at: '2026-06-11T01:00:00Z',
      });
    }
    if (method === 'POST' && path === '/api/proxy/sessions/sess_1/predict') {
      const step = script[Math.min(predictCalls, script.length - 1)]!;
      predictCalls++;
      return json({ ...step, step: predictCalls });
    }
    if (method === 'POST' && path === '/api/local-runs/r_local1/events') {
      return json({ appended: body.events.length });
    }
    if (method === 'POST' && path === '/api/local-runs/r_local1/frame') {
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/api/runs/r_local1')
      return json({ id: 'r_local1', kind: 'local', status: runStatus });
    if (method === 'PATCH' && path === '/api/local-runs/r_local1')
      return json({ id: 'r_local1', status: body.status });
    if (method === 'DELETE' && path === '/api/proxy/sessions/sess_1')
      return json({ deleted: true });
    return json({ error: { code: 'NOT_FOUND', message: `unmatched ${method} ${path}` } }, 404);
  }) as typeof fetch;

  const mirrored = (): BackendRunEvent[] =>
    requests
      .filter((r) => r.method === 'POST' && r.path === '/api/local-runs/r_local1/events')
      .flatMap((r) => r.body.events as BackendRunEvent[]);

  const frames = (): { base64: string; width: number; height: number }[] =>
    requests
      .filter((r) => r.method === 'POST' && r.path === '/api/local-runs/r_local1/frame')
      .map((r) => r.body as { base64: string; width: number; height: number });

  return {
    requests,
    fetchImpl,
    mirrored,
    frames,
    predictCalls: () => predictCalls,
    setRunStatus: (s: string) => {
      runStatus = s;
    },
  };
}

function makeManager(
  backend: ReturnType<typeof fakeBackend>,
  executor: Executor,
  overrides: Partial<ConstructorParameters<typeof LocalRunManager>[0]> = {},
) {
  return new LocalRunManager({
    backendUrl: 'http://backend.test',
    getToken: () => 'tok_1',
    createExecutor: () => executor,
    fetchImpl: backend.fetchImpl,
    settleMs: 0,
    machineLabel: 'test-machine',
    ...overrides,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('LocalRunManager — happy path', () => {
  it('creates the run + session, predicts until done, mirrors ordered events, cleans up', async () => {
    const { executor, executed, state } = fakeExecutor();
    const backend = fakeBackend();
    const manager = makeManager(backend, executor);

    const { runId } = await manager.start({ task: 'open notepad', maxSteps: 5 });
    expect(runId).toBe('r_local1');
    expect(manager.runningRunId).toBe('r_local1');
    await manager.whenIdle();
    expect(manager.runningRunId).toBeNull();

    const calls = backend.requests.map((r) => `${r.method} ${r.path}`);
    // (a) local run registered first, with task/maxSteps/machineLabel
    expect(calls[0]).toBe('POST /api/local-runs');
    expect(backend.requests[0]!.body).toMatchObject({
      task: 'open notepad',
      maxSteps: 5,
      machineLabel: 'test-machine',
    });
    // (b) proxy session created with the executor's real dimensions
    expect(calls[1]).toBe('POST /api/proxy/sessions');
    expect(backend.requests[1]!.body).toMatchObject({ screenWidth: 1280, screenHeight: 720 });
    // (c) predict ran twice (continue → done) and the click was executed locally
    expect(calls.filter((c) => c.includes('/predict'))).toHaveLength(2);
    expect(executed).toEqual(['click']);
    // (e) session deleted, executor disposed
    expect(calls).toContain('DELETE /api/proxy/sessions/sess_1');
    expect(state.disposed).toBe(true);
    // every request authenticated with the injected token
    expect(backend.requests.every((r) => r.headers.Authorization === 'Bearer tok_1')).toBe(true);

    // (d) mirrored events: tool_call/step/done present and ordered; done LAST
    const events = backend.mirrored();
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('step');
    expect(types).toContain('billing');
    expect(types.indexOf('tool_call')).toBeLessThan(types.lastIndexOf('done'));
    expect(types.indexOf('step')).toBeLessThan(types.lastIndexOf('done'));
    expect(types[types.length - 1]).toBe('done');
    expect(types.filter((t) => t === 'done')).toHaveLength(1);

    const done = events[events.length - 1]!;
    expect(done.data).toMatchObject({
      status: 'succeeded',
      result: { passed: true, summary: 'task complete' },
    });

    // tool_call carries the raw action; billing accumulates cost
    const toolCall = events.find((e) => e.type === 'tool_call')!;
    expect(toolCall.data.action).toEqual(CLICK);
    const billing = events.filter((e) => e.type === 'billing').map((e) => e.data.cost_cents);
    expect(billing).toEqual([4, 8]);
    // steps mirror progress
    const steps = events.filter((e) => e.type === 'step').map((e) => e.data.steps_completed);
    expect(steps).toEqual([1, 2]);
    // screenshots are never uploaded — only a small text marker per step
    expect(JSON.stringify(events)).not.toContain('A'.repeat(200));
    expect(
      events.filter((e) => e.type === 'text' && String(e.data.text).includes('screenshot')),
    ).toHaveLength(2);

    // final PATCH closes the run with status + accumulated cost
    const patch = backend.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ status: 'succeeded', costCents: 8 });
  });

  it('rejects a second start while a run is active and reports missing auth', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend({
      predictScript: [predictResponse({ actions: [CLICK], reasoning: 'going' })],
    });
    const manager = makeManager(backend, executor, { settleMs: 5 });
    await manager.start({ task: 'long task', maxSteps: 50 });
    await expect(manager.start({ task: 'another' })).rejects.toThrow(/already in progress/);
    await manager.cancel();

    const anon = makeManager(backend, executor, { getToken: () => null });
    await expect(anon.start({ task: 'x' })).rejects.toThrow(/Not signed in/);
  });
});

describe('LocalRunManager — cancel', () => {
  it('cancel() mid-run aborts the loop and mirrors a final done event with status cancelled', async () => {
    const { executor, state } = fakeExecutor();
    // Predict never finishes on its own.
    const backend = fakeBackend({
      predictScript: [predictResponse({ actions: [CLICK], reasoning: 'still going' })],
    });
    const manager = makeManager(backend, executor, { settleMs: 10 });

    const sawPrediction = new Promise<void>((resolve) => {
      manager.onEvent((ev: AgentLoopEvent) => {
        if (ev.type === 'prediction') resolve();
      });
    });

    await manager.start({ task: 'never-ending', maxSteps: 500 });
    await sawPrediction;
    await manager.cancel();

    const events = backend.mirrored();
    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    expect(last.data).toMatchObject({ status: 'cancelled', result: { passed: false } });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const patch = backend.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body.status).toBe('cancelled');
    // session cleaned up even on cancellation
    expect(
      backend.requests.some(
        (r) => r.method === 'DELETE' && r.path === '/api/proxy/sessions/sess_1',
      ),
    ).toBe(true);
    expect(state.disposed).toBe(true);
    // cancel again when idle is a no-op
    await expect(manager.cancel()).resolves.toBeUndefined();
  });
});

describe('LocalRunManager — cross-device cancel', () => {
  it('aborts the loop when the run is cancelled from another device', async () => {
    const { executor, state } = fakeExecutor();
    // Predict never finishes on its own — only an external cancel ends it.
    const backend = fakeBackend({
      predictScript: [predictResponse({ actions: [CLICK], reasoning: 'still going' })],
    });
    const manager = makeManager(backend, executor, { settleMs: 10, cancelPollMs: 5 });

    const sawPrediction = new Promise<void>((resolve) => {
      manager.onEvent((ev: AgentLoopEvent) => {
        if (ev.type === 'prediction') resolve();
      });
    });

    await manager.start({ task: 'cancelled-from-phone', maxSteps: 500 });
    await sawPrediction;
    // A browser/phone hits POST /api/runs/:id/cancel → backend marks it cancelled.
    backend.setRunStatus('cancelled');

    // The watcher must notice and abort the local loop without any IPC call.
    await manager.whenIdle();
    expect(manager.runningRunId).toBeNull();

    const events = backend.mirrored();
    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    expect(last.data).toMatchObject({ status: 'cancelled', result: { passed: false } });
    const patch = backend.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body.status).toBe('cancelled');
    // session cleaned up + executor disposed, exactly like a direct cancel
    expect(backend.requests.some((r) => r.method === 'DELETE')).toBe(true);
    expect(state.disposed).toBe(true);
  });

  it('does not abort a healthy run (status stays running)', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend(); // default: continue → done
    const manager = makeManager(backend, executor, { settleMs: 20, cancelPollMs: 5 });
    await manager.start({ task: 'finishes normally', maxSteps: 5 });
    await manager.whenIdle();
    const last = backend.mirrored().at(-1)!;
    expect(last.data).toMatchObject({ status: 'succeeded' });
  });

  it('a failing status poll never disrupts the run', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend();
    const base = backend.fetchImpl;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if ((init?.method ?? 'GET') === 'GET' && path === '/api/runs/r_local1') {
        throw new Error('status poll exploded');
      }
      return base(input, init);
    }) as typeof fetch;
    const manager = makeManager(backend, executor, { settleMs: 20, cancelPollMs: 5, fetchImpl });
    await manager.start({ task: 'resilient to poll failures', maxSteps: 5 });
    await manager.whenIdle();
    const last = backend.mirrored().at(-1)!;
    expect(last.type).toBe('done');
    expect(last.data).toMatchObject({ status: 'succeeded' });
  });
});

describe('LocalRunManager — failure paths', () => {
  it('repeated action-execution failures end the run failed with mirrored error events', async () => {
    const { executor, state } = fakeExecutor({ failExecute: true });
    const backend = fakeBackend({
      predictScript: [predictResponse({ actions: [CLICK], reasoning: 'try clicking' })],
    });
    const manager = makeManager(backend, executor);

    await manager.start({ task: 'doomed', maxSteps: 10 });
    await manager.whenIdle();

    const events = backend.mirrored();
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(3); // loop default: 3 consecutive failures → fail
    expect(String(errors[0]!.data.message)).toContain('input blocked');

    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    expect(last.data).toMatchObject({ status: 'failed', result: { passed: false } });

    const patch = backend.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body.status).toBe('failed');
    expect(state.disposed).toBe(true);
  });

  it('an executor screenshot crash is surfaced as a failed run (error + done mirrored)', async () => {
    const { executor, state } = fakeExecutor({ failScreenshot: true });
    const backend = fakeBackend();
    const manager = makeManager(backend, executor);
    const finished = vi.fn();
    manager.onEvent((ev) => {
      if (ev.type === 'finished') finished(ev);
    });

    await manager.start({ task: 'cannot even look', maxSteps: 5 });
    await manager.whenIdle();

    const events = backend.mirrored();
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    const done = events[events.length - 1]!;
    expect(done.data).toMatchObject({ status: 'failed' });
    expect((done.data.result as { summary: string }).summary).toContain('capture daemon crashed');
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: 'fail' }));
    // session is still deleted and the executor disposed
    expect(backend.requests.some((r) => r.method === 'DELETE')).toBe(true);
    expect(state.disposed).toBe(true);
  });
});

describe('LocalRunManager — live screen frames', () => {
  it('forwards the captured frame (real base64 + dims) to the frame channel', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend({
      predictScript: [
        predictResponse({ actions: [CLICK], reasoning: 'click' }),
        predictResponse({ status: 'done', reasoning: 'done' }),
      ],
    });
    const manager = makeManager(backend, executor, { frameMs: 0 });
    await manager.start({ task: 'show my screen', maxSteps: 5 });
    await manager.whenIdle();

    const frames = backend.frames();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    // the actual screenshot bytes go to the frame channel, NOT the event log
    expect(frames[0]!.base64).toBe('A'.repeat(200));
    expect(frames[0]).toMatchObject({ width: 1280, height: 720 });
    expect(JSON.stringify(backend.mirrored())).not.toContain('A'.repeat(200));
  });

  it('throttles frame uploads: with a large frameMs only the first frame is sent', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend({
      predictScript: [
        predictResponse({ actions: [CLICK], reasoning: '1' }),
        predictResponse({ actions: [CLICK], reasoning: '2' }),
        predictResponse({ actions: [CLICK], reasoning: '3' }),
        predictResponse({ status: 'done', reasoning: 'done' }),
      ],
    });
    // settleMs 0 → steps fire back-to-back well within the 60s frame throttle.
    const manager = makeManager(backend, executor, { frameMs: 60_000 });
    await manager.start({ task: 'many steps', maxSteps: 10 });
    await manager.whenIdle();
    // 4 screenshots captured, but only the first frame uploaded (throttled).
    expect(backend.frames()).toHaveLength(1);
  });

  it('a frame upload failure never affects the run', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend({
      predictScript: [predictResponse({ status: 'done', reasoning: 'instant' })],
    });
    // Wrap fetch so every frame POST rejects; the run must still succeed.
    const base = backend.fetchImpl;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/frame')) throw new Error('frame upload exploded');
      return base(input, init);
    }) as typeof fetch;
    const manager = makeManager(backend, executor, { frameMs: 0, fetchImpl });
    await manager.start({ task: 'resilient', maxSteps: 3 });
    await manager.whenIdle();
    const last = backend.mirrored().at(-1)!;
    expect(last.type).toBe('done');
    expect(last.data).toMatchObject({ status: 'succeeded' });
  });
});

describe('LocalRunManager — event batching', () => {
  it('flushes everything across multiple batches, preserves order, done is LAST', async () => {
    const { executor } = fakeExecutor();
    // 4 continue-steps with two actions each, then done → 29 mirrored events.
    const continueStep = (n: number) =>
      predictResponse({ actions: [CLICK, TYPE], reasoning: `step ${n}` });
    const backend = fakeBackend({
      predictScript: [
        continueStep(1),
        continueStep(2),
        continueStep(3),
        continueStep(4),
        predictResponse({ status: 'done', reasoning: 'all done' }),
      ],
    });
    const manager = makeManager(backend, executor);

    await manager.start({ task: 'busy task', maxSteps: 10 });
    await manager.whenIdle();

    const eventPosts = backend.requests.filter(
      (r) => r.method === 'POST' && r.path === '/api/local-runs/r_local1/events',
    );
    // batching actually happened: more than one POST, none above the API cap
    expect(eventPosts.length).toBeGreaterThanOrEqual(2);
    for (const post of eventPosts) {
      expect(post.body.events.length).toBeGreaterThanOrEqual(1);
      expect(post.body.events.length).toBeLessThanOrEqual(100);
    }

    const events = backend.mirrored();
    const counts = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
    // no lost events: 5 steps × (screenshot text + reasoning text + billing + step) + 8 tool_calls + 1 done
    expect(counts).toEqual({ text: 10, billing: 5, step: 5, tool_call: 8, done: 1 });
    expect(events).toHaveLength(29);
    expect(events[events.length - 1]!.type).toBe('done');

    // order preserved across batch boundaries: steps_completed strictly increases
    const stepValues = events
      .filter((e) => e.type === 'step')
      .map((e) => e.data.steps_completed as number);
    expect(stepValues).toEqual([1, 2, 3, 4, 5]);
    // billing strictly accumulates in order too
    const billing = events
      .filter((e) => e.type === 'billing')
      .map((e) => e.data.cost_cents as number);
    expect(billing).toEqual([4, 8, 12, 16, 20]);
  });

  it('the 500ms timer flushes a small queue without waiting for the batch threshold', async () => {
    const { executor } = fakeExecutor();
    const backend = fakeBackend({
      predictScript: [predictResponse({ actions: [CLICK], reasoning: 'slow burn' })],
    });
    // Big settle so the run stays alive long after step 1 mirrored only ~5 events.
    const manager = makeManager(backend, executor, { settleMs: 2_000, flushMs: 50 });

    await manager.start({ task: 'slow task', maxSteps: 3 });
    // Wait for the timer-driven flush (well under one settle period).
    await vi.waitFor(
      () => {
        expect(backend.mirrored().length).toBeGreaterThanOrEqual(4);
      },
      { timeout: 1_500 },
    );
    // The run is still in flight — this flush came from the timer, not the finish drain.
    expect(manager.runningRunId).toBe('r_local1');
    expect(backend.mirrored().some((e) => e.type === 'done')).toBe(false);
    await manager.cancel();
    expect(backend.mirrored().at(-1)!.type).toBe('done');
  });
});
