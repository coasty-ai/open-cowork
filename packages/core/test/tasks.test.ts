/**
 * Submit-and-forget tasks: the cost model and the client surface.
 *
 * A task is the only endpoint that bills TWO meters at once (agent steps AND
 * ephemeral machine runtime), and the only one whose returned run starts with a
 * null machine_id. Both properties are easy to regress silently, so they are
 * pinned here rather than left to the integration suite.
 */
import { describe, expect, it } from 'vitest';
import {
  CoastyApiError,
  CoastyClient,
  CUA_VERSIONS,
  DEFAULT_TASK_DEADLINE_SECONDS,
  DEFAULT_TASK_MAX_STEPS,
  isCuaVersion,
  machineRuntimeCentsPerHour,
  PRICING,
  RUN_SCREENSHOTS_IMAGE_PAGE_LIMIT,
  runEstimateCents,
  runStepCents,
  taskEstimateCents,
  type FetchLike,
} from '../src/index';

const BASE = 'https://coasty.test/v1';
const KEY = 'sk-coasty-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

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

const client = (fetchImpl: FetchLike) =>
  new CoastyClient({
    baseUrl: BASE,
    apiKey: KEY,
    fetchImpl,
    retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0.5 },
  });

// ── engine versions ──────────────────────────────────────────────────────────

describe('cua versions', () => {
  it('exposes all four shipped engines', () => {
    expect(CUA_VERSIONS).toEqual(['v1', 'v3', 'v4', 'v5']);
  });

  it('prices v3, v4 and v5 identically; only v1 surcharges', () => {
    expect(runStepCents('v3')).toBe(5);
    expect(runStepCents('v4')).toBe(5);
    expect(runStepCents('v5')).toBe(5);
    expect(runStepCents('v1')).toBe(8);
  });

  it('guards isCuaVersion against near-misses', () => {
    expect(isCuaVersion('v5')).toBe(true);
    for (const bad of ['v2', 'V5', 'v6', '', 5, null, undefined]) {
      expect(isCuaVersion(bad)).toBe(false);
    }
  });
});

// ── task cost model ──────────────────────────────────────────────────────────

describe('taskEstimateCents', () => {
  it('sums BOTH meters: agent steps plus ephemeral machine runtime', () => {
    // 10 steps x 5cr = 50cr, plus one hour of Linux runtime = 5cr.
    const est = taskEstimateCents({ maxSteps: 10, deadlineSeconds: 3600, osType: 'linux' });
    expect(est.stepsCents).toBe(50);
    expect(est.machineCents).toBe(5);
    expect(est.maxCents).toBe(55);
  });

  it('is strictly more expensive than the same run estimate — the difference is the machine', () => {
    // This is the whole reason a task cannot reuse runEstimateCents: confirming
    // a run-shaped number would under-quote the user by the machine runtime.
    const run = runEstimateCents({ cuaVersion: 'v5', maxSteps: 10 });
    const task = taskEstimateCents({ cuaVersion: 'v5', maxSteps: 10, deadlineSeconds: 3600 });
    expect(task.maxCents).toBeGreaterThan(run.maxCents);
    expect(task.maxCents - run.maxCents).toBe(task.machineCents);
  });

  it('charges the Windows runtime premium', () => {
    const linux = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 3600, osType: 'linux' });
    const windows = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 3600, osType: 'windows' });
    expect(linux.machineCents).toBe(machineRuntimeCentsPerHour('linux', 'running'));
    expect(windows.machineCents).toBe(machineRuntimeCentsPerHour('windows', 'running'));
    expect(windows.maxCents).toBeGreaterThan(linux.maxCents);
  });

  it('ROUNDS THE MACHINE COMPONENT UP so the quote can never be exceeded', () => {
    // Runtime meters per minute rounded DOWN in the caller's favour. A worst-case
    // quote must round the other way, or the handshake promises a ceiling the
    // run can breach. One minute of Linux is 5/60 of a credit -> must quote 1.
    const est = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 60, osType: 'linux' });
    expect(est.machineCents).toBe(1);
    expect(est.machineCents).toBeGreaterThan(0);
  });

  it('never quotes zero machine cost for a non-zero deadline', () => {
    for (const seconds of [1, 30, 59, 60, 61, 3599]) {
      expect(taskEstimateCents({ deadlineSeconds: seconds }).machineCents).toBeGreaterThan(0);
    }
  });

  it('scales the machine component linearly with the deadline', () => {
    const oneHour = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 3600 }).machineCents;
    const fourHours = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 4 * 3600 }).machineCents;
    expect(fourHours).toBe(oneHour * 4);
  });

  it('applies the documented upstream defaults when nothing is supplied', () => {
    const est = taskEstimateCents({});
    expect(est.maxSteps).toBe(DEFAULT_TASK_MAX_STEPS);
    expect(est.deadlineSeconds).toBe(DEFAULT_TASK_DEADLINE_SECONDS);
    expect(est.osType).toBe('linux');
    // Default engine for a task is v5, which prices like v3.
    expect(est.perStepCents).toBe(5);
    expect(est.stepsCents).toBe(DEFAULT_TASK_MAX_STEPS * 5);
  });

  it('bills at least one step as the floor', () => {
    expect(taskEstimateCents({ maxSteps: 1 }).minCents).toBe(5);
    expect(taskEstimateCents({ cuaVersion: 'v1', maxSteps: 1 }).minCents).toBe(8);
  });

  it('applies the v1 engine surcharge to every step', () => {
    const est = taskEstimateCents({ cuaVersion: 'v1', maxSteps: 10, deadlineSeconds: 3600 });
    expect(est.perStepCents).toBe(8);
    expect(est.stepsCents).toBe(80);
    expect(est.maxCents).toBe(85);
  });

  it('handles the maximum deadline without overflowing into nonsense', () => {
    const est = taskEstimateCents({ maxSteps: 1000, deadlineSeconds: 86400, osType: 'windows' });
    expect(est.machineCents).toBe(Math.ceil((9 * 86400) / 3600)); // 216
    expect(est.maxCents).toBe(5000 + 216);
    expect(Number.isSafeInteger(est.maxCents)).toBe(true);
  });

  it('keeps the provisioning gate distinct from the estimate (it is a gate, not a fee)', () => {
    const est = taskEstimateCents({ maxSteps: 1, deadlineSeconds: 60 });
    expect(est.maxCents).toBeLessThan(PRICING.provisioningGateCents);
  });
});

// ── client surface ───────────────────────────────────────────────────────────

const TASK_RUN = {
  id: 'run_abc',
  object: 'agent.run',
  status: 'queued',
  machine_id: null,
  machine: {
    mode: 'automatic',
    status: 'provisioning',
    id: null,
    cleanup: 'always',
    cleanup_status: 'pending',
  },
  task: 'Download the newest invoice',
  cua_version: 'v5',
  max_steps: 150,
  on_awaiting_human: 'fail',
  steps_completed: 0,
  webhook_secret: 'whsec_one_time',
};

describe('CoastyClient.createTask', () => {
  it('POSTs /tasks and returns the run with a null machine_id while provisioning', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(TASK_RUN, 201)]);
    const run = await client(fetchImpl).createTask({ task: 'Download the newest invoice' });
    expect(calls[0]!.url).toBe(`${BASE}/tasks`);
    expect(calls[0]!.method).toBe('POST');
    expect(run.machine_id).toBeNull();
    expect(run.machine?.status).toBe('provisioning');
    expect(run.machine?.cleanup).toBe('always');
    expect(run.webhook_secret).toBe('whsec_one_time');
  });

  it('forwards the Idempotency-Key header', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(TASK_RUN, 201)]);
    await client(fetchImpl).createTask({ task: 'x' }, { idempotencyKey: 'invoice-4821' });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('invoice-4821');
  });

  it('does NOT retry an unkeyed create — a duplicate task means a duplicate machine', async () => {
    // The single most expensive mistake this client can make: retrying an
    // unkeyed task create can leave a second ephemeral VM running and billing.
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), { status: 500 });
    };
    await expect(client(fetchImpl).createTask({ task: 'x' })).rejects.toBeInstanceOf(
      CoastyApiError,
    );
    expect(attempts).toBe(1);
  });

  it('DOES retry a keyed create, reusing the same key so upstream dedupes it', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), { status: 500 });
      }
      return new Response(JSON.stringify(TASK_RUN), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const run = await client(fetchImpl).createTask({ task: 'x' }, { idempotencyKey: 'k1' });
    expect(attempts).toBe(2);
    expect(run.id).toBe('run_abc');
  });

  it('sends machine preferences through untouched, without inventing sizing defaults', async () => {
    // Omitted sizing fields must stay omitted so the machine service applies
    // its own current safe defaults.
    const { fetchImpl, calls } = scriptedFetch([json(TASK_RUN, 201)]);
    await client(fetchImpl).createTask({
      task: 'x',
      machine: { provider: 'daytona', os_type: 'windows', desktop_enabled: true },
    });
    const body = calls[0]!.body as { machine: Record<string, unknown> };
    expect(body.machine).toEqual({
      provider: 'daytona',
      os_type: 'windows',
      desktop_enabled: true,
    });
    expect(body.machine).not.toHaveProperty('cpu_cores');
  });

  it('surfaces the async-BYOK-on-a-test-key rejection as a typed error', async () => {
    const { fetchImpl } = scriptedFetch([
      json(
        {
          error: {
            code: 'LLM_PROVIDER_UNSUPPORTED',
            message: 'BYOK is unavailable for synthetic test runs',
            request_id: 'req_1',
          },
        },
        422,
      ),
    ]);
    await expect(
      client(fetchImpl).createTask({ task: 'x', llm: { provider: 'anthropic' } }),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_UNSUPPORTED', status: 422 });
  });
});

describe('CoastyClient.listRunScreenshots', () => {
  const page = { object: 'list', data: [], has_more: false };

  it('defaults to metadata only — no query string at all', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(page)]);
    await client(fetchImpl).listRunScreenshots('run_abc');
    expect(calls[0]!.url).toBe(`${BASE}/runs/run_abc/screenshots`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('serializes paging and image-inlining options', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(page)]);
    await client(fetchImpl).listRunScreenshots('run_abc', {
      after_index: 4,
      limit: 10,
      include_image: true,
    });
    expect(calls[0]!.url).toContain('after_index=4');
    expect(calls[0]!.url).toContain('limit=10');
    expect(calls[0]!.url).toContain('include_image=true');
  });

  it('sends include_image=false explicitly rather than dropping it', async () => {
    // `false` is meaningful: it is the difference between "unspecified" and
    // "definitely do not inline". A falsy-check bug here would silently drop it.
    const { fetchImpl, calls } = scriptedFetch([json(page)]);
    await client(fetchImpl).listRunScreenshots('run_abc', { include_image: false });
    expect(calls[0]!.url).toContain('include_image=false');
  });

  it('sends after_index=0 rather than dropping a falsy zero cursor', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(page)]);
    await client(fetchImpl).listRunScreenshots('run_abc', { after_index: 0 });
    expect(calls[0]!.url).toContain('after_index=0');
  });

  it('url-encodes the run id', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(page)]);
    await client(fetchImpl).listRunScreenshots('run/../etc');
    expect(calls[0]!.url).toBe(`${BASE}/runs/run%2F..%2Fetc/screenshots`);
  });

  it('retries a GET on a transient failure (reads are safely idempotent)', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify({ error: { code: 'DB_UNAVAILABLE' } }), { status: 503 });
      }
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await client(fetchImpl).listRunScreenshots('run_abc');
    expect(attempts).toBe(3);
  });

  it('parses a degraded frame and an undecodable one without losing the page', async () => {
    const { fetchImpl } = scriptedFetch([
      json({
        object: 'list',
        data: [
          { index: 0, attempt: 1, step: 1, degraded: true, width: 1280, height: 720 },
          { index: 1, attempt: 2, step: 1, image_unavailable: true, width: 1280, height: 720 },
        ],
        has_more: true,
      }),
    ]);
    const res = await client(fetchImpl).listRunScreenshots('run_abc', { include_image: true });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.degraded).toBe(true);
    expect(res.data[1]!.image_unavailable).toBe(true);
    // `step` restarts per attempt, so index is the only stable address.
    expect(res.data[0]!.step).toBe(res.data[1]!.step);
    expect(res.data[0]!.index).not.toBe(res.data[1]!.index);
    expect(res.has_more).toBe(true);
  });

  it('documents the upstream image page clamp', () => {
    expect(RUN_SCREENSHOTS_IMAGE_PAGE_LIMIT).toBe(10);
  });
});
