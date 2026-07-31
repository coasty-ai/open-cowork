/**
 * Feature-coverage E2E: every capability exercised through the real stack
 * (built SPA → backend → mock Coasty over HTTP), complementing the narrative
 * journeys in `web.spec.ts`.
 *
 * Where a capability has no UI affordance (paging model-input frames, pinning
 * an action policy, replaying an SSE stream from a cursor) it is driven from
 * the browser's own session with the SAME token the SPA uses — which also
 * proves the rule is enforced server-side rather than by a disabled button.
 */
import { expect, test, type Page } from '@playwright/test';

const SECRET_PATTERNS = [/sk-coasty-(?:live|test)-[0-9a-fA-F]{8,}/, /whsec_[0-9a-zA-Z]{8,}/];

function watchForSecrets(page: Page): () => void {
  const leaks: string[] = [];
  page.on('request', (req) => {
    const blob = `${req.url()} ${req.postData() ?? ''} ${JSON.stringify(req.headers())}`;
    for (const re of SECRET_PATTERNS) if (re.test(blob)) leaks.push(`${req.method()} ${req.url()}`);
  });
  return () => expect(leaks, 'Coasty secret material must never leave the backend').toEqual([]);
}

const email = `e2e-features-${Date.now()}@example.com`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

interface ApiResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/**
 * Call the backend from inside the page, reusing the SPA's stored session
 * token. Returns status + headers + parsed body so header-level guarantees
 * (`Cache-Control: no-store` on inlined frames) can be asserted too.
 */
async function api<T = unknown>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ path, init }) => {
      const raw = localStorage.getItem('cowork-session');
      const token = raw ? (JSON.parse(raw) as { state: { token: string } }).state.token : '';
      const res = await fetch(path, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, headers, body };
    },
    { path, init },
  ) as Promise<ApiResult<T>>;
}

interface RunDto {
  id: string;
  kind: string;
  status: string;
  cuaVersion: string;
  machineId: string | null;
  deadlineSeconds: number | null;
  actionPolicy: Record<string, unknown> | null;
  machine: { cleanup_status: string; status: string; id: string | null } | null;
}

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];

/** Start a managed task through the API, echoing a freshly-fetched estimate. */
async function startTask(
  page: Page,
  body: Record<string, unknown> = {},
): Promise<ApiResult<RunDto>> {
  const { maxSteps = 8, deadlineSeconds = 3600 } = body;
  const estimate = await api<{ cents: number }>(page, '/api/estimate', {
    method: 'POST',
    body: { kind: 'task', maxSteps, deadlineSeconds },
  });
  return api<RunDto>(page, '/api/tasks', {
    method: 'POST',
    body: {
      task: 'Download the newest invoice and verify it',
      maxSteps,
      deadlineSeconds,
      confirmCostCents: estimate.body.cents,
      ...body,
    },
  });
}

async function waitForRun(
  page: Page,
  id: string,
  done: (run: RunDto) => boolean,
  timeoutMs = 45_000,
): Promise<RunDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api<RunDto>(page, `/api/runs/${id}`);
    if (res.status === 200 && done(res.body)) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`waitForRun timed out; last state: ${JSON.stringify(res.body)}`);
    }
    await page.waitForTimeout(250);
  }
}

// ── machines ─────────────────────────────────────────────────────────────────

test.describe('machines', () => {
  test('full lifecycle through the UI: provision → stop → start → terminate', async ({ page }) => {
    const assertNoLeaks = watchForSecrets(page);
    await login(page);
    await page.getByRole('link', { name: /machines/i }).click();
    await expect(page.getByRole('heading', { name: /^machines$/i })).toBeVisible();

    // Provision a machine dedicated to this test so terminating it cannot
    // strand another spec that expects a runnable machine to exist.
    const name = `lifecycle-${Date.now() % 100000}`;
    await page.getByRole('button', { name: /provision machine/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/name/i).fill(name);
    // The cost is stated before anything is created, and the TTL bounds spend.
    await expect(dialog).toContainText('$0.05/hour');
    await expect(dialog).toContainText('$0.20 wallet minimum');
    await dialog.getByLabel(/auto-terminate/i).fill('30');
    await dialog.getByRole('button', { name: /confirm — provision/i }).click();

    const card = page.locator('.oc-machine-card', { hasText: name });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(/running/i)).toBeVisible({ timeout: 20_000 });
    // Rate is shown on the card at all times.
    await expect(card).toContainText('$0.05/hr');

    // running → stopped. Start is disabled while running, and vice versa.
    await expect(card.getByRole('button', { name: /^start$/i })).toBeDisabled();
    await card.getByRole('button', { name: /^stop$/i }).click();
    await expect(card.getByText(/stopped/i)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('button', { name: /^stop$/i })).toBeDisabled();

    // stopped → running.
    await card.getByRole('button', { name: /^start$/i }).click();
    await expect(card.getByText(/running/i)).toBeVisible({ timeout: 20_000 });

    // Terminate is a two-press arm/confirm, so a stray click cannot destroy a VM.
    await card.getByRole('button', { name: /^terminate$/i }).click();
    await expect(card.getByRole('button', { name: /confirm terminate\?/i })).toBeVisible();
    await card.getByRole('button', { name: /confirm terminate\?/i }).click();
    await expect(page.locator('.oc-machine-card', { hasText: name })).toHaveCount(0, {
      timeout: 20_000,
    });

    assertNoLeaks();
  });

  test('an illegal lifecycle transition is refused by the server', async ({ page }) => {
    await login(page);
    const created = await api<{ machine: { id: string } }>(page, '/api/machines', {
      method: 'POST',
      body: { displayName: `state-${Date.now() % 100000}`, osType: 'linux', confirmCostCents: 5 },
    });
    expect(created.status).toBe(201);
    const id = created.body.machine.id;

    // A test-key machine is born `running`, so starting it again is illegal.
    const bad = await api<{ error: { code: string; current_state?: string } }>(
      page,
      `/api/machines/${id}/start`,
      { method: 'POST', body: {} },
    );
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INVALID_STATE');

    await api(page, `/api/machines/${id}`, { method: 'DELETE' });
  });

  test('the machine rate must be confirmed before provisioning', async ({ page }) => {
    await login(page);
    const wrong = await api<{ error: { code: string; details: { expectedCents: number } } }>(
      page,
      '/api/machines',
      {
        method: 'POST',
        body: { displayName: 'no-confirm', osType: 'windows', confirmCostCents: 5 },
      },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('ESTIMATE_CHANGED');
    // Windows bills 9¢/hr, not Linux's 5¢.
    expect(wrong.body.error.details.expectedCents).toBe(9);
  });

  test('client-facing machine commands are allowlisted', async ({ page }) => {
    // Terminal execution and raw browser JS need elevated Coasty scopes and are
    // deliberately not exposed; a disabled button is not a security boundary.
    await login(page);
    const created = await api<{ machine: { id: string } }>(page, '/api/machines', {
      method: 'POST',
      body: { displayName: `allow-${Date.now() % 100000}`, osType: 'linux', confirmCostCents: 5 },
    });
    const id = created.body.machine.id;

    const denied = await api<{ error: { code: string; details: { allowed: string[] } } }>(
      page,
      `/api/machines/${id}/actions`,
      { method: 'POST', body: { command: 'browser_execute', parameters: { code: '1+1' } } },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('COMMAND_NOT_ALLOWED');
    expect(denied.body.error.details.allowed).toContain('click');
    expect(denied.body.error.details.allowed).not.toContain('browser_execute');

    // An allowlisted command still works.
    const ok = await api(page, `/api/machines/${id}/actions`, {
      method: 'POST',
      body: { command: 'click', parameters: { x: 10, y: 10 } },
    });
    expect(ok.status).toBe(200);

    await api(page, `/api/machines/${id}`, { method: 'DELETE' });
  });
});

// ── managed tasks ────────────────────────────────────────────────────────────

test.describe('managed tasks', () => {
  test('defaults to v5, pins the deadline, and provisions its own machine', async ({ page }) => {
    await login(page);
    const created = await startTask(page);
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('task');
    expect(created.body.cuaVersion).toBe('v5');
    expect(created.body.deadlineSeconds).toBe(3600);
    // Intentionally null until provisioning completes.
    expect(created.body.machineId).toBeNull();

    const provisioned = await waitForRun(page, created.body.id, (r) => r.machineId !== null);
    expect(provisioned.machineId).toMatch(/^mch_test_/);

    const done = await waitForRun(page, created.body.id, (r) => TERMINAL.includes(r.status));
    expect(done.status).toBe('succeeded');
  });

  test('a task estimate exceeds the equivalent run estimate by the machine runtime', async ({
    page,
  }) => {
    await login(page);
    const task = await api<{ cents: number; breakdown: { machineCents: number } }>(
      page,
      '/api/estimate',
      { method: 'POST', body: { kind: 'task', maxSteps: 10, deadlineSeconds: 3600 } },
    );
    const run = await api<{ cents: number }>(page, '/api/estimate', {
      method: 'POST',
      body: { kind: 'run', cuaVersion: 'v5', maxSteps: 10 },
    });
    expect(task.body.cents - run.body.cents).toBe(task.body.breakdown.machineCents);

    // Echoing the RUN number at /api/tasks is the mistake a client makes by
    // reusing its run code path; the handshake must catch it.
    const rejected = await api<{ error: { code: string } }>(page, '/api/tasks', {
      method: 'POST',
      body: {
        task: 'go',
        maxSteps: 10,
        deadlineSeconds: 3600,
        confirmCostCents: run.body.cents,
      },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('ESTIMATE_CHANGED');
  });

  test('cancelling mid-flight still tears the machine down', async ({ page }) => {
    // The important guarantee: an abandoned task must not leak a billing VM.
    await login(page);
    const created = await startTask(page, { task: 'RUN_LONG keep working', maxSteps: 80 });
    expect(created.status).toBe(201);

    const provisioned = await waitForRun(page, created.body.id, (r) => r.machineId !== null);
    const cancelled = await api<RunDto>(page, `/api/runs/${created.body.id}/cancel`, {
      method: 'POST',
      body: {},
    });
    expect(cancelled.status).toBe(200);

    const settled = await waitForRun(
      page,
      created.body.id,
      (r) => r.machine?.cleanup_status === 'terminated',
    );
    expect(settled.status).toBe('cancelled');
    expect(settled.machine?.status).toBe('released');

    // The VM really is gone: it no longer appears in the machines list.
    const machines = await api<{ machines: { id: string }[] }>(page, '/api/machines');
    expect(machines.body.machines.map((m) => m.id)).not.toContain(provisioned.machineId);
  });

  test('cannot be resumed, because it never pauses', async ({ page }) => {
    await login(page);
    const created = await startTask(page);
    const res = await api<{ error: { code: string; message: string } }>(
      page,
      `/api/runs/${created.body.id}/resume`,
      { method: 'POST', body: { note: 'carry on' } },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_SUPPORTED');
    expect(res.body.error.message).toMatch(/never pause/i);
  });

  test('a malformed action policy is refused; a valid one is pinned to the run', async ({
    page,
  }) => {
    await login(page);
    const estimate = await api<{ cents: number }>(page, '/api/estimate', {
      method: 'POST',
      body: { kind: 'task', maxSteps: 8, deadlineSeconds: 3600 },
    });

    // allowed_actions and blocked_actions may not overlap.
    const bad = await api(page, '/api/tasks', {
      method: 'POST',
      body: {
        task: 'go',
        maxSteps: 8,
        deadlineSeconds: 3600,
        confirmCostCents: estimate.body.cents,
        actionPolicy: { allowed_actions: ['click'], blocked_actions: ['click'] },
      },
    });
    expect(bad.status).toBe(400);

    // A valid policy is stored verbatim — Coasty never echoes the normalized
    // form back, so our copy IS the audit record.
    const policy = { blocked_keys: ['escape'], block_window_close: true, max_actions: 5 };
    const good = await startTask(page, { actionPolicy: policy });
    expect(good.status).toBe(201);
    expect(good.body.actionPolicy).toEqual(policy);
    const reread = await api<RunDto>(page, `/api/runs/${good.body.id}`);
    expect(reread.body.actionPolicy).toEqual(policy);
  });

  test('a provisioning failure is reported as a failed run, not a silent success', async ({
    page,
  }) => {
    await login(page);
    const created = await startTask(page, { task: 'PROVISION_FAIL fetch the invoice' });
    const done = await waitForRun(page, created.body.id, (r) => TERMINAL.includes(r.status));
    expect(done.status).toBe('failed');
    expect(done.machineId).toBeNull();
  });

  test('appears in the runs list alongside ordinary runs', async ({ page }) => {
    await login(page);
    const created = await startTask(page, { task: 'List me please, invoice run' });
    const list = await api<{ runs: RunDto[] }>(page, '/api/runs');
    const found = list.body.runs.find((r) => r.id === created.body.id);
    expect(found?.kind).toBe('task');

    // And renders in the UI runs table.
    await page.getByRole('link', { name: /^runs$/i }).click();
    await expect(page.getByText(/list me please/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

// ── model-input frames ───────────────────────────────────────────────────────

test.describe('model-input frames', () => {
  test('paginate, inline on request with no-store, and outlive the machine', async ({ page }) => {
    await login(page);
    const created = await startTask(page);
    const settled = await waitForRun(
      page,
      created.body.id,
      (r) => r.machine?.cleanup_status === 'terminated',
    );
    const runId = created.body.id;

    interface Frame {
      index: number;
      width: number;
      height: number;
      sha256: string;
      degraded: boolean;
      image_b64?: string;
    }
    type Page_ = { data: Frame[]; has_more: boolean };

    // Metadata only by default — no multi-hundred-KB payloads.
    const meta = await api<Page_>(page, `/api/runs/${runId}/screenshots`);
    expect(meta.status).toBe(200);
    expect(meta.body.data.length).toBeGreaterThan(1);
    expect(meta.body.data[0]).not.toHaveProperty('image_b64');
    // `index` is flat and monotonic from zero; sha256 identifies the bytes.
    expect(meta.body.data.map((f) => f.index)).toEqual(meta.body.data.map((_, i) => i));
    expect(meta.body.data[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Distinct frames, not the same image repeated — the agent saw the screen change.
    expect(new Set(meta.body.data.map((f) => f.sha256)).size).toBe(meta.body.data.length);
    // Reported dimensions are the MODEL coordinate space.
    expect(meta.body.data[0]!.width).toBe(1280);
    expect(meta.body.data[0]!.height).toBe(720);

    // afterIndex is an exclusive cursor.
    const paged = await api<Page_>(page, `/api/runs/${runId}/screenshots?afterIndex=0`);
    expect(paged.body.data[0]!.index).toBe(1);

    // Inlining the bytes must forbid caching all the way to the browser: a
    // frame can show an inbox, a dashboard, or a billing page.
    const withImage = await api<Page_>(page, `/api/runs/${runId}/screenshots?includeImage=true`);
    expect(withImage.headers['cache-control']).toBe('no-store');
    expect(withImage.body.data[0]!.image_b64).toBeTruthy();

    // The machine that produced these frames is already destroyed.
    expect(settled.machine?.cleanup_status).toBe('terminated');
    const machines = await api<{ machines: { id: string }[] }>(page, '/api/machines');
    expect(machines.body.machines.map((m) => m.id)).not.toContain(settled.machineId);

    // A negative cursor is rejected rather than silently coerced.
    const negative = await api(page, `/api/runs/${runId}/screenshots?afterIndex=-1`);
    expect(negative.status).toBe(400);
  });

  test('a local run answers with an empty page instead of a 404', async ({ page }) => {
    // One client code path has to work for every run kind.
    await login(page);
    const local = await api<{ id: string }>(page, '/api/local-runs', {
      method: 'POST',
      body: { task: 'local job', maxSteps: 3 },
    });
    const res = await api<{ data: unknown[]; has_more: boolean }>(
      page,
      `/api/runs/${local.body.id}/screenshots`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ── realtime ─────────────────────────────────────────────────────────────────

test.describe('realtime', () => {
  test('the event timeline replays from a cursor with no gaps or duplicates', async ({ page }) => {
    await login(page);
    const created = await startTask(page);
    await waitForRun(page, created.body.id, (r) => TERMINAL.includes(r.status));

    const all = await api<{ events: { seq: number; type: string }[]; done: boolean }>(
      page,
      `/api/runs/${created.body.id}/events.json`,
    );
    expect(all.body.events.length).toBeGreaterThan(3);
    expect(all.body.done).toBe(true);
    const seqs = all.body.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(all.body.events.map((e) => e.type)).toContain('billing');

    // Resuming from a cursor returns exactly the tail, with no overlap.
    const cursor = seqs[2]!;
    const tail = await api<{ events: { seq: number }[] }>(
      page,
      `/api/runs/${created.body.id}/events.json?after=${cursor}`,
    );
    expect(tail.body.events[0]!.seq).toBe(cursor + 1);
    expect(tail.body.events.at(-1)!.seq).toBe(seqs.at(-1));
  });

  test('the per-user activity feed carries run lifecycle notifications over SSE', async ({
    page,
  }) => {
    await login(page);
    const created = await startTask(page, { task: 'Feed me, invoice run' });
    await waitForRun(page, created.body.id, (r) => TERMINAL.includes(r.status));

    // Read the real SSE notification stream. `/api/events` replays everything
    // persisted for this user before switching to live, so opening it after the
    // fact is deterministic — that durable replay IS the feature being tested.
    // EventSource cannot send an Authorization header, which is exactly why the
    // SPA streams it with fetch; do the same here.
    const feed = await page.evaluate(
      async ({ runId }) => {
        const raw = localStorage.getItem('cowork-session');
        const token = raw ? (JSON.parse(raw) as { state: { token: string } }).state.token : '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const seen: { type: string; data: string }[] = [];
        try {
          const res = await fetch('/api/events', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const type = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
              const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
              if (type) seen.push({ type, data });
            }
            // Stop as soon as this run's terminal notification has arrived.
            if (seen.some((e) => e.type.startsWith('run.') && e.data.includes(runId))) break;
          }
          void reader.cancel();
        } catch {
          // aborted on timeout — assert on whatever arrived
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        return seen;
      },
      { runId: created.body.id },
    );

    const forThisRun = feed.filter((e) => e.data.includes(created.body.id));
    expect(forThisRun.map((e) => e.type)).toContain('run.created');
    // The terminal notification is what makes cross-device supervision work.
    expect(forThisRun.some((e) => e.type === 'run.succeeded')).toBe(true);
  });
});

// ── wallet, settings and auth ────────────────────────────────────────────────

test.describe('account surfaces', () => {
  test('wallet shows a balance and this month’s spend', async ({ page }) => {
    await login(page);
    const wallet = await api<{ balanceCents: number; monthSpendCents: number }>(
      page,
      '/api/wallet',
    );
    expect(wallet.status).toBe(200);
    expect(typeof wallet.body.balanceCents).toBe('number');
    expect(typeof wallet.body.monthSpendCents).toBe('number');
  });

  test('settings reports the key mode without ever exposing the key', async ({ page }) => {
    const assertNoLeaks = watchForSecrets(page);
    await login(page);
    const status = await api<Record<string, unknown>>(page, '/api/config/coasty-key');
    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(true);
    // Mode is an enum, never the value.
    expect(status.body.mode).toBe('test');
    expect(JSON.stringify(status.body)).not.toMatch(/sk-coasty-/);

    await page.getByRole('link', { name: /settings/i }).click();
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible();
    assertNoLeaks();
  });

  test('every API route requires a bearer token', async ({ page }) => {
    await login(page);
    const unauth = await page.evaluate(async () => {
      const paths = ['/api/runs', '/api/machines', '/api/wallet', '/api/tasks'];
      const out: { path: string; status: number }[] = [];
      for (const path of paths) {
        const res = await fetch(path, {
          method: path === '/api/tasks' ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          ...(path === '/api/tasks'
            ? { body: JSON.stringify({ task: 'x', confirmCostCents: 1 }) }
            : {}),
        });
        out.push({ path, status: res.status });
      }
      return out;
    });
    for (const { path, status } of unauth) {
      expect([path, status]).toEqual([path, 401]);
    }
  });
});

// ── workflows ────────────────────────────────────────────────────────────────

test.describe('workflows', () => {
  test('an invalid definition is rejected with per-issue detail, before any spend', async ({
    page,
  }) => {
    await login(page);
    const res = await api<{ valid: boolean; issues: { path: string }[] }>(
      page,
      '/api/workflows/validate',
      {
        method: 'POST',
        // `parallel` may not contain a human_approval step — a documented limit.
        body: {
          definition: {
            steps: [
              {
                id: 'p',
                type: 'parallel',
                branches: [[{ id: 'a', type: 'human_approval', message: 'ok?' }]],
              },
            ],
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  test('a valid definition validates for free and returns a cost estimate', async ({ page }) => {
    await login(page);
    const res = await api<{ valid: boolean; estimate: { typicalCents: number } }>(
      page,
      '/api/workflows/validate',
      {
        method: 'POST',
        body: {
          definition: {
            steps: [
              { id: 't1', type: 'task', task: 'open the portal', save_as: 'first' },
              { id: 'a1', type: 'assert', condition: { op: 'truthy', value: '{{first.passed}}' } },
            ],
          },
        },
      },
    );
    expect(res.body.valid).toBe(true);
    expect(res.body.estimate.typicalCents).toBeGreaterThan(0);
  });
});
