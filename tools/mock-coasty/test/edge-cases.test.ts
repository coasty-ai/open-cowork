/**
 * Edge-case coverage: the full error catalog, idempotency replay across every
 * billed resource, documented headers on billed + unbilled responses, the
 * pyautogui parser variants, ground/session/usage accounting, machine ops, and
 * workflow control flow (ad-hoc/loop/retry/parallel/deadline/cancel/SSE-after).
 * Everything deterministic and offline — see helpers.ts for primitives.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { buildSignature, parsePyautogui } from '../src/index';
import { call, createMachine, LIVE_KEY, mock, pollUntil, SCREENSHOT, TEST_KEY } from './helpers';

let m: MockCoasty | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
});

type ErrBody = {
  error: {
    code: string;
    type: string;
    message: string;
    request_id: string;
    valid_options?: string[];
    current_state?: string;
    allowed_from?: string[];
    details?: unknown;
    required?: number;
    balance?: number;
    max?: number;
    min?: number;
    actual?: number;
  };
};

const err = (res: { json<T = unknown>(): T }) => (res.json() as ErrBody).error;

// ── 1. Error catalog completeness ───────────────────────────────────────────

describe('error catalog: every documented code + its coarse type', () => {
  it('INVALID_LIMIT (limit=0 and 999) on /runs, /machines, /workflows → 400 validation_error', async () => {
    m = mock();
    for (const base of ['/v1/runs', '/v1/machines', '/v1/workflows']) {
      for (const limit of [0, 999]) {
        const res = await call(m, `${base}?limit=${limit}`);
        expect(res.statusCode).toBe(400);
        const e = err(res);
        expect(e.code).toBe('INVALID_LIMIT');
        expect(e.type).toBe('validation_error');
        expect(e.max).toBe(200);
        expect(e.min).toBe(1);
        expect(e.actual).toBe(limit);
      }
    }
  });

  it('non-integer limit is also rejected by INVALID_LIMIT', async () => {
    m = mock();
    const res = await call(m, '/v1/runs?limit=abc');
    expect(res.statusCode).toBe(400);
    expect(err(res).code).toBe('INVALID_LIMIT');
  });

  it('INVALID_STATUS_FILTER lists every valid run status', async () => {
    m = mock();
    const res = await call(m, '/v1/runs?status=nope');
    expect(res.statusCode).toBe(400);
    const e = err(res);
    expect(e.code).toBe('INVALID_STATUS_FILTER');
    expect(e.type).toBe('validation_error');
    expect(e.valid_options).toEqual([
      'queued',
      'running',
      'awaiting_human',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ]);
  });

  it('SESSION_NOT_FOUND → 404 not_found_error', async () => {
    m = mock();
    const res = await call(m, '/v1/sessions/sess_ghost', { key: LIVE_KEY });
    expect(res.statusCode).toBe(404);
    expect(err(res).code).toBe('SESSION_NOT_FOUND');
    expect(err(res).type).toBe('not_found_error');
  });

  it('RUN_NOT_FOUND → 404 not_found_error (get/cancel/resume/events all agree)', async () => {
    m = mock();
    const get = await call(m, '/v1/runs/run_ghost');
    expect(get.statusCode).toBe(404);
    expect(err(get).code).toBe('RUN_NOT_FOUND');
    expect(err(get).type).toBe('not_found_error');
    for (const sub of ['cancel', 'resume']) {
      const res = await call(m, `/v1/runs/run_ghost/${sub}`, { method: 'POST', body: {} });
      expect(res.statusCode).toBe(404);
      expect(err(res).code).toBe('RUN_NOT_FOUND');
    }
    const events = await call(m, '/v1/runs/run_ghost/events');
    expect(events.statusCode).toBe(404);
    expect(err(events).code).toBe('RUN_NOT_FOUND');
  });

  it('WORKFLOW_NOT_FOUND → 404 (get/put/delete/{id}/runs)', async () => {
    m = mock();
    const get = await call(m, '/v1/workflows/wf_ghost');
    expect(get.statusCode).toBe(404);
    expect(err(get).code).toBe('WORKFLOW_NOT_FOUND');
    expect(err(get).type).toBe('not_found_error');
    const put = await call(m, '/v1/workflows/wf_ghost', { method: 'PUT', body: { name: 'x' } });
    expect(err(put).code).toBe('WORKFLOW_NOT_FOUND');
    const del = await call(m, '/v1/workflows/wf_ghost', { method: 'DELETE' });
    expect(err(del).code).toBe('WORKFLOW_NOT_FOUND');
    const run = await call(m, '/v1/workflows/wf_ghost/runs', { method: 'POST', body: {} });
    expect(err(run).code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('MACHINE_NOT_FOUND → 404 not_found_error', async () => {
    m = mock();
    const res = await call(m, '/v1/machines/mch_ghost');
    expect(res.statusCode).toBe(404);
    expect(err(res).code).toBe('MACHINE_NOT_FOUND');
    expect(err(res).type).toBe('not_found_error');
  });

  it('NOT_AWAITING_HUMAN → 409 state_error (run + workflow run)', async () => {
    m = mock();
    // run that is still running (not awaiting)
    const machineId = await createMachine(m);
    const created = await call(m, '/v1/runs', {
      method: 'POST',
      body: { machine_id: machineId, task: 'RUN_LONG plenty of steps' },
    });
    const runId = (created.json() as { id: string }).id;
    const res = await call(m, `/v1/runs/${runId}/resume`, { method: 'POST', body: {} });
    expect(res.statusCode).toBe(409);
    expect(err(res).code).toBe('NOT_AWAITING_HUMAN');
    expect(err(res).type).toBe('state_error');
  });

  it('INVALID_STATE carries current_state + allowed_from (machine start)', async () => {
    m = mock();
    const id = await createMachine(m); // running
    const res = await call(m, `/v1/machines/${id}/start`, { method: 'POST', body: {} });
    expect(res.statusCode).toBe(409);
    const e = err(res);
    expect(e.code).toBe('INVALID_STATE');
    expect(e.type).toBe('state_error');
    expect(e.current_state).toBe('running');
    expect(e.allowed_from).toEqual(['stopped']);
  });

  it('VALIDATION_ERROR on missing required fields → 422 validation_error', async () => {
    m = mock();
    // machine create without display_name
    const noName = await call(m, '/v1/machines', { method: 'POST', body: {} });
    expect(noName.statusCode).toBe(422);
    expect(err(noName).code).toBe('VALIDATION_ERROR');
    expect(err(noName).type).toBe('validation_error');
    // run create without machine_id
    const noMachine = await call(m, '/v1/runs', { method: 'POST', body: { task: 'x' } });
    expect(err(noMachine).code).toBe('VALIDATION_ERROR');
    // workflow create without name
    const noWfName = await call(m, '/v1/workflows', {
      method: 'POST',
      body: { slug: 'a', definition: { steps: [{ id: 't', type: 'succeed' }] } },
    });
    expect(err(noWfName).code).toBe('VALIDATION_ERROR');
  });

  it('IDEMPOTENCY_KEY_REUSED → 422 validation_error', async () => {
    m = mock();
    const machineId = await createMachine(m);
    const body = { machine_id: machineId, task: 'idem task' };
    await call(m, '/v1/runs', { method: 'POST', body, headers: { 'idempotency-key': 'k1' } });
    const reused = await call(m, '/v1/runs', {
      method: 'POST',
      body: { ...body, task: 'changed' },
      headers: { 'idempotency-key': 'k1' },
    });
    expect(reused.statusCode).toBe(422);
    expect(err(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(err(reused).type).toBe('validation_error');
  });

  it('INSUFFICIENT_CREDITS → 402 billing_error with required + balance', async () => {
    m = mock({ walletCents: 2 });
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screenshot: SCREENSHOT, instruction: 'click' },
    });
    expect(res.statusCode).toBe(402);
    const e = err(res);
    expect(e.code).toBe('INSUFFICIENT_CREDITS');
    expect(e.type).toBe('billing_error');
    expect(e.required).toBeGreaterThan(0);
    expect(e.balance).toBe(2);
  });

  it('NOT_FOUND 404 handler for an unknown route', async () => {
    m = mock();
    const res = await call(m, '/v1/this/does/not/exist');
    expect(res.statusCode).toBe(404);
    const e = err(res);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.type).toBe('not_found_error');
    expect(e.message).toContain('GET');
  });

  it('unknown route still requires auth (401 before 404)', async () => {
    m = mock();
    const res = await call(m, '/v1/nope', { key: 'garbage' });
    expect(res.statusCode).toBe(401);
    expect(err(res).code).toBe('INVALID_API_KEY');
  });
});

// ── 2. Idempotency across runs / machines / workflow runs ────────────────────

describe('idempotency replay', () => {
  it('runs: same key+body replays same id with X-Coasty-Idempotent-Replay: true', async () => {
    m = mock();
    const machineId = await createMachine(m);
    const body = { machine_id: machineId, task: 'replay me' };
    const first = await call(m, '/v1/runs', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'run-key' },
    });
    expect(first.headers['x-coasty-idempotent-replay']).toBeUndefined();
    const second = await call(m, '/v1/runs', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'run-key' },
    });
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect(second.headers['x-coasty-idempotent-replay']).toBe('true');
  });

  it('machines: same key+body replays same id; different body → 422', async () => {
    m = mock();
    const body = { display_name: 'idem-vm', os_type: 'linux' };
    const first = await call(m, '/v1/machines', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'mch-key' },
    });
    const firstId = (first.json() as { machine: { id: string } }).machine.id;
    const second = await call(m, '/v1/machines', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'mch-key' },
    });
    expect((second.json() as { machine: { id: string } }).machine.id).toBe(firstId);
    expect(second.headers['x-coasty-idempotent-replay']).toBe('true');
    const conflict = await call(m, '/v1/machines', {
      method: 'POST',
      body: { ...body, display_name: 'other' },
      headers: { 'idempotency-key': 'mch-key' },
    });
    expect(conflict.statusCode).toBe(422);
    expect(err(conflict).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('workflow runs: same key+body replays same id; different body → 422', async () => {
    m = mock();
    const machineId = await createMachine(m);
    const definition = { steps: [{ id: 'ok', type: 'succeed' }] };
    const body = { definition, machine_id: machineId };
    const first = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'wf-key' },
    });
    const firstId = (first.json() as { id: string }).id;
    const second = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': 'wf-key' },
    });
    expect((second.json() as { id: string }).id).toBe(firstId);
    expect(second.headers['x-coasty-idempotent-replay']).toBe('true');
    const conflict = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body: { ...body, inputs: { changed: true } },
      headers: { 'idempotency-key': 'wf-key' },
    });
    expect(conflict.statusCode).toBe(422);
    expect(err(conflict).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

// ── 3. Documented headers on billed + unbilled responses ─────────────────────

describe('documented response headers', () => {
  it('X-Coasty-Request-Id is present on success and on errors', async () => {
    m = mock();
    const ok = await call(m, '/v1/models');
    expect(ok.headers['x-coasty-request-id']).toMatch(/^req_/);
    const notFound = await call(m, '/v1/machines/mch_ghost');
    expect(notFound.headers['x-coasty-request-id']).toMatch(/^req_/);
  });

  it('test keys: X-Coasty-Key-Kind test, X-Coasty-Test-Mode true, X-Credits-Charged 0', async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      key: TEST_KEY,
      body: { screenshot: SCREENSHOT, instruction: 'click' },
    });
    expect(res.headers['x-coasty-key-kind']).toBe('test');
    expect(res.headers['x-coasty-test-mode']).toBe('true');
    expect(res.headers['x-credits-charged']).toBe('0');
  });

  it('live keys: no test-mode header; X-Credits-Charged + Remaining track the wallet', async () => {
    m = mock({ walletCents: 100 });
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      key: LIVE_KEY,
      body: {
        screenshot: SCREENSHOT,
        instruction: 'click',
        screen_width: 1280,
        screen_height: 720,
      },
    });
    expect(res.headers['x-coasty-key-kind']).toBe('live');
    expect(res.headers['x-coasty-test-mode']).toBeUndefined();
    expect(res.headers['x-credits-charged']).toBe('5');
    expect(res.headers['x-credits-remaining']).toBe('95');
  });

  it('an unbilled GET still carries request-id + key-kind', async () => {
    m = mock();
    const res = await call(m, '/v1/usage', { key: LIVE_KEY });
    expect(res.headers['x-coasty-request-id']).toMatch(/^req_/);
    expect(res.headers['x-coasty-key-kind']).toBe('live');
  });
});

// ── 4. parsePyautogui variants ───────────────────────────────────────────────

describe('parsePyautogui variants', () => {
  it('doubleClick → click with clicks:2; rightClick → click button:right', () => {
    expect(parsePyautogui('pyautogui.doubleClick(10, 20)')).toEqual([
      { action_type: 'click', params: { x: 10, y: 20, clicks: 2 } },
    ]);
    expect(parsePyautogui('pyautogui.rightClick(30, 40)')).toEqual([
      { action_type: 'click', params: { x: 30, y: 40, button: 'right' } },
    ]);
  });

  it('dragTo → drag with x2/y2', () => {
    expect(parsePyautogui('pyautogui.dragTo(7, 8)')).toEqual([
      { action_type: 'drag', params: { x2: 7, y2: 8 } },
    ]);
  });

  it('write vs typewrite both become type_text (single and double quotes)', () => {
    expect(parsePyautogui("pyautogui.write('alpha')")).toEqual([
      { action_type: 'type_text', params: { text: 'alpha' } },
    ]);
    expect(parsePyautogui('pyautogui.typewrite("beta")')).toEqual([
      { action_type: 'type_text', params: { text: 'beta' } },
    ]);
  });

  it('hotkey with 3 keys collects all keys', () => {
    expect(parsePyautogui("pyautogui.hotkey('ctrl', 'shift', 'p')")).toEqual([
      { action_type: 'key_combo', params: { keys: ['ctrl', 'shift', 'p'] } },
    ]);
  });

  it('junk and blank lines are ignored; valid lines still parse', () => {
    const code = [
      '# a comment',
      '',
      'import pyautogui',
      '   ',
      'pyautogui.click(1, 2)',
      'totally unrelated garbage',
      "pyautogui.press('enter')",
    ].join('\n');
    expect(parsePyautogui(code)).toEqual([
      { action_type: 'click', params: { x: 1, y: 2 } },
      { action_type: 'key_press', params: { key: 'enter' } },
    ]);
  });

  it('empty source yields no actions', () => {
    expect(parsePyautogui('')).toEqual([]);
  });
});

// ── 5. ground HD boundary, session reset/list, usage breakdown ───────────────

describe('ground HD surcharge boundary', () => {
  it('1280x720 → 3cr; 1281x720 → 4cr (HD +1)', async () => {
    m = mock();
    const ground = (w: number, h: number) =>
      call(m!, '/v1/ground', {
        method: 'POST',
        key: LIVE_KEY,
        body: { screenshot: SCREENSHOT, element: 'a button', screen_width: w, screen_height: h },
      });
    expect((await ground(1280, 720)).headers['x-credits-charged']).toBe('3');
    expect((await ground(1281, 720)).headers['x-credits-charged']).toBe('4');
    expect((await ground(1280, 721)).headers['x-credits-charged']).toBe('4');
  });

  it('ground rejects empty element with VALIDATION_ERROR', async () => {
    m = mock();
    const res = await call(m, '/v1/ground', {
      method: 'POST',
      body: { screenshot: SCREENSHOT, element: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(err(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('sessions: reset, list, info', () => {
  it('reset zeroes step_count; list reflects sessions; reset 404 on unknown', async () => {
    m = mock({ defaultRunSteps: 5 });
    const create = await call(m, '/v1/sessions', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screen_width: 1280, screen_height: 720 },
    });
    const sessionId = (create.json() as { session_id: string }).session_id;
    const step = () =>
      call(m!, `/v1/sessions/${sessionId}/predict`, {
        method: 'POST',
        key: LIVE_KEY,
        body: { screenshot: SCREENSHOT, instruction: 'click it' },
      });
    await step();
    await step();
    const before = await call(m, `/v1/sessions/${sessionId}`, { key: LIVE_KEY });
    expect((before.json() as { step_count: number }).step_count).toBe(2);

    const list = await call(m, '/v1/sessions', { key: LIVE_KEY });
    const sessions = (list.json() as { sessions: { session_id: string }[] }).sessions;
    expect(sessions.map((s) => s.session_id)).toContain(sessionId);

    const reset = await call(m, `/v1/sessions/${sessionId}/reset`, {
      method: 'POST',
      key: LIVE_KEY,
      body: {},
    });
    expect((reset.json() as { status: string }).status).toBe('ok');
    const after = await call(m, `/v1/sessions/${sessionId}`, { key: LIVE_KEY });
    expect((after.json() as { step_count: number }).step_count).toBe(0);

    const ghost = await call(m, '/v1/sessions/sess_ghost/reset', { method: 'POST', body: {} });
    expect(ghost.statusCode).toBe(404);
    expect(err(ghost).code).toBe('SESSION_NOT_FOUND');
  });
});

describe('usage breakdown', () => {
  it('accumulates credits per family and wallet_balance_usd is cents/100', async () => {
    m = mock({ walletCents: 1000 });
    const predict = () =>
      call(m!, '/v1/predict', {
        method: 'POST',
        key: LIVE_KEY,
        body: {
          screenshot: SCREENSHOT,
          instruction: 'a',
          screen_width: 1280,
          screen_height: 720,
        },
      });
    await predict();
    await predict();
    await call(m, '/v1/ground', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screenshot: SCREENSHOT, element: 'b', screen_width: 1280, screen_height: 720 },
    });
    const usage = (await call(m, '/v1/usage', { key: LIVE_KEY })).json() as {
      total_credits: number;
      breakdown: Record<string, { requests: number; credits: number }>;
      wallet_balance_cents: number;
      wallet_balance_usd: number;
    };
    // 2 predicts @5 + 1 ground @3 = 13
    expect(usage.breakdown.predict?.credits).toBe(10);
    expect(usage.breakdown.predict?.requests).toBe(2);
    expect(usage.breakdown.ground?.credits).toBe(3);
    expect(usage.total_credits).toBe(13);
    expect(usage.wallet_balance_cents).toBe(1000 - 13);
    expect(usage.wallet_balance_usd).toBeCloseTo((1000 - 13) / 100, 5);
  });

  it('test keys record requests but bill 0 in the breakdown', async () => {
    m = mock();
    await call(m, '/v1/predict', {
      method: 'POST',
      key: TEST_KEY,
      body: { screenshot: SCREENSHOT, instruction: 'a' },
    });
    const usage = (await call(m, '/v1/usage')).json() as {
      total_credits: number;
      breakdown: Record<string, { requests: number; credits: number }>;
    };
    expect(usage.breakdown.predict?.requests).toBe(1);
    expect(usage.breakdown.predict?.credits).toBe(0);
    expect(usage.total_credits).toBe(0);
  });
});

// ── 6. machines: restart, ttl, connection, browser, terminal, files, batch ───

describe('machines edge cases', () => {
  it('restart only from running; stopped → 409 INVALID_STATE', async () => {
    m = mock();
    const id = await createMachine(m);
    const ok = await call(m, `/v1/machines/${id}/restart`, { method: 'POST', body: {} });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('running');
    await call(m, `/v1/machines/${id}/stop`, { method: 'POST', body: {} });
    const bad = await call(m, `/v1/machines/${id}/restart`, { method: 'POST', body: {} });
    expect(bad.statusCode).toBe(409);
    const e = err(bad);
    expect(e.code).toBe('INVALID_STATE');
    expect(e.current_state).toBe('stopped');
    expect(e.allowed_from).toEqual(['running']);
  });

  it('ttl: 0 clears to null; a valid value sets it', async () => {
    m = mock();
    const id = await createMachine(m);
    const set = await call(m, `/v1/machines/${id}`, { method: 'PATCH', body: { ttl_minutes: 30 } });
    expect((set.json() as { ttl_minutes: number }).ttl_minutes).toBe(30);
    const clear = await call(m, `/v1/machines/${id}`, {
      method: 'PATCH',
      body: { ttl_minutes: 0 },
    });
    expect((clear.json() as { ttl_minutes: number | null }).ttl_minutes).toBeNull();
  });

  it('connection details set Cache-Control: no-store and include a PEM', async () => {
    m = mock();
    const id = await createMachine(m);
    const res = await call(m, `/v1/machines/${id}/connection`);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { ssh_private_key_pem: string; websocket_url: string };
    expect(body.ssh_private_key_pem).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(body.websocket_url).toContain('ws://');
  });

  it('browser op unknown → 404 with valid_options; known op succeeds', async () => {
    m = mock();
    const id = await createMachine(m);
    const bad = await call(m, `/v1/machines/${id}/browser/teleport`, { method: 'POST', body: {} });
    expect(bad.statusCode).toBe(404);
    const e = err(bad);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.valid_options).toContain('navigate');
    const ok = await call(m, `/v1/machines/${id}/browser/click`, {
      method: 'POST',
      body: { parameters: { selector: '#go' } },
    });
    expect((ok.json() as { success: boolean; command: string }).command).toBe('browser_click');
  });

  it('terminal: pwd (default + cwd), echo, canned fallback, output truncated to 5000', async () => {
    m = mock();
    const id = await createMachine(m);
    const term = (command: string, cwd?: string) =>
      call(m!, `/v1/machines/${id}/terminal`, {
        method: 'POST',
        body: { command, ...(cwd ? { cwd } : {}) },
      });
    expect((await term('pwd')).json()).toMatchObject({ output: '/home/ubuntu', exit_code: 0 });
    expect((await term('pwd', '/srv/app')).json()).toMatchObject({ output: '/srv/app' });
    expect((await term('echo hi there')).json()).toMatchObject({ output: 'hi there' });
    const canned = await term('ls -la /');
    expect((canned.json() as { output: string }).output).toBe('mock: executed: ls -la /');
    // A long echo arg (within the 8192-char command limit) must be capped at 5000 chars.
    const big = await term(`echo ${'z'.repeat(6000)}`);
    expect((big.json() as { output: string }).output.length).toBe(5000);
    // A command over 8192 chars is rejected before execution.
    const tooLong = await call(m, `/v1/machines/${id}/terminal`, {
      method: 'POST',
      body: { command: 'echo ' + 'z'.repeat(9000) },
    });
    expect(tooLong.statusCode).toBe(422);
    expect(err(tooLong).code).toBe('VALIDATION_ERROR');
    // empty command rejected
    const empty = await call(m, `/v1/machines/${id}/terminal`, {
      method: 'POST',
      body: { command: '' },
    });
    expect(empty.statusCode).toBe(422);
    expect(err(empty).code).toBe('VALIDATION_ERROR');
  });

  it('files: append builds content; list-directory + delete-directory; read missing → 404', async () => {
    m = mock();
    const id = await createMachine(m);
    const file = (op: string, params: Record<string, unknown>) =>
      call(m!, `/v1/machines/${id}/files/${op}`, { method: 'POST', body: { parameters: params } });

    await file('write', { path: '/d/a.txt', content: 'one' });
    await file('append', { path: '/d/a.txt', content: 'two' });
    const read = await file('read', { path: '/d/a.txt' });
    expect((read.json() as { content: string }).content).toBe('onetwo');

    await file('write', { path: '/d/b.txt', content: 'b' });
    const list = await file('list-directory', { path: '/d' });
    const entries = (list.json() as { entries: string[] }).entries;
    expect(entries).toEqual(expect.arrayContaining(['/d/a.txt', '/d/b.txt']));

    const exists = await file('exists', { path: '/d/a.txt' });
    expect((exists.json() as { exists: boolean }).exists).toBe(true);

    const delDir = await file('delete-directory', { path: '/d' });
    expect((delDir.json() as { success: boolean }).success).toBe(true);
    const gone = await file('read', { path: '/d/a.txt' });
    expect(gone.statusCode).toBe(404);
    expect(err(gone).code).toBe('NOT_FOUND');

    // delete a missing file → 404; edit a missing file → 404
    const delMissing = await file('delete', { path: '/d/nope.txt' });
    expect(delMissing.statusCode).toBe(404);
    const editMissing = await file('edit', { path: '/d/nope.txt', old_text: 'x', new_text: 'y' });
    expect(editMissing.statusCode).toBe(404);

    // unknown file op → 404
    const unknown = await file('teleport', { path: '/d/a.txt' });
    expect(unknown.statusCode).toBe(404);
    expect(err(unknown).code).toBe('NOT_FOUND');

    // download / list-downloads canned
    const dl = await file('download', { path: '/d/a.txt' });
    expect((dl.json() as { downloads: unknown[] }).downloads).toEqual([]);
  });

  it('actions on a stopped machine → 409; batch + terminal + browser all gated by running', async () => {
    m = mock();
    const id = await createMachine(m);
    await call(m, `/v1/machines/${id}/stop`, { method: 'POST', body: {} });
    const action = await call(m, `/v1/machines/${id}/actions`, {
      method: 'POST',
      body: { command: 'click' },
    });
    expect(action.statusCode).toBe(409);
    expect(err(action).current_state).toBe('stopped');
    const batch = await call(m, `/v1/machines/${id}/actions/batch`, {
      method: 'POST',
      body: { steps: [{ command: 'click' }] },
    });
    expect(batch.statusCode).toBe(409);
    const term = await call(m, `/v1/machines/${id}/terminal`, {
      method: 'POST',
      body: { command: 'echo x' },
    });
    expect(term.statusCode).toBe(409);
    const browser = await call(m, `/v1/machines/${id}/browser/navigate`, {
      method: 'POST',
      body: {},
    });
    expect(browser.statusCode).toBe(409);
  });

  it('batch with stop_on_error:false keeps going (completed + failed counts)', async () => {
    m = mock();
    const id = await createMachine(m);
    const batch = await call(m, `/v1/machines/${id}/actions/batch`, {
      method: 'POST',
      body: {
        steps: [{ command: 'click' }, { command: 'MOCK_ERROR' }, { command: 'type' }],
        stop_on_error: false,
      },
    });
    const body = batch.json() as {
      completed_count: number;
      failed_count: number;
      aborted: boolean;
      results: unknown[];
    };
    expect(body.aborted).toBe(false);
    expect(body.failed_count).toBe(1);
    expect(body.completed_count).toBe(2);
    expect(body.results).toHaveLength(3); // all three ran
  });

  it('batch validation: empty steps → 422', async () => {
    m = mock();
    const id = await createMachine(m);
    const res = await call(m, `/v1/machines/${id}/actions/batch`, {
      method: 'POST',
      body: { steps: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(err(res).code).toBe('VALIDATION_ERROR');
  });

  it('screenshot frames differ between captures and advance the frame counter', async () => {
    m = mock();
    const id = await createMachine(m);
    const cap = () =>
      call(m!, `/v1/machines/${id}/screenshot`).then(
        (r) => (r.json() as { image_b64: string }).image_b64,
      );
    const a = await cap();
    const b = await cap();
    const c = await cap();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ── 7. workflows: ad-hoc, loop, retry, parallel, deadline, cancel, SSE after ─

describe('workflows control flow', () => {
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

  it('ad-hoc run without a definition → 422 VALIDATION_ERROR', async () => {
    m = mock();
    const machineId = await createMachine(m);
    const res = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body: { machine_id: machineId },
    });
    expect(res.statusCode).toBe(422);
    expect(err(res).code).toBe('VALIDATION_ERROR');
    expect(err(res).message).toContain('definition');
  });

  it("loop 'count' reports iterations_used", async () => {
    m = mock();
    const res = await adhoc({
      steps: [{ id: 'l', type: 'loop', count: 4, body: [task('t', 'tick')] }],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.iterations_used).toBe(4);
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
            task('flaky', 'attempt MUST_FAIL_ONCE', 'out'),
            { id: 'chk', type: 'assert', condition: { op: 'truthy', value: '{{out.passed}}' } },
          ],
        },
        { id: 'ok', type: 'succeed', output: { recovered: true } },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.output).toEqual({ recovered: true });
  });

  it('parallel binds both branch results', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        {
          id: 'p',
          type: 'parallel',
          branches: [[task('l', 'left', 'L')], [task('r', 'right', 'R')]],
        },
        {
          id: 'chk',
          type: 'if',
          condition: {
            op: 'and',
            conditions: [
              { op: 'eq', left: '{{L.status}}', right: 'succeeded' },
              { op: 'eq', left: '{{R.status}}', right: 'succeeded' },
            ],
          },
          then: [{ id: 'yes', type: 'succeed', output: { both: 'bound' } }],
          else: [{ id: 'no', type: 'fail', message: 'missing branch' }],
        },
      ],
    });
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'succeeded');
    expect(run.output).toEqual({ both: 'bound' });
  });

  it('deadline_seconds → timed_out (small deadline + many task substeps)', async () => {
    m = mock({ tickMs: 20, defaultRunSteps: 40 });
    const res = await adhoc(
      { steps: [{ id: 'l', type: 'loop', count: 50, body: [task('t', 'grind')] }] },
      { deadline_seconds: 1 },
    );
    const id = (res.json() as { id: string }).id;
    const run = await waitFor(id, 'timed_out', 8000);
    expect(run.status).toBe('timed_out');
  });

  it('cancel a queued workflow run → cancelled immediately', async () => {
    m = mock({ tickMs: 400 }); // slow kickoff so the run is still queued
    const machineId = await createMachine(m);
    const res = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body: {
        definition: { steps: [task('t', 'go'), { id: 'ok', type: 'succeed' }] },
        machine_id: machineId,
      },
    });
    const id = (res.json() as { id: string; status: string }).id;
    expect((res.json() as { status: string }).status).toBe('queued');
    const cancel = await call(m, `/v1/workflows/runs/${id}/cancel`, { method: 'POST', body: {} });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelled');
    // cancelling again → 409 INVALID_STATE
    const again = await call(m, `/v1/workflows/runs/${id}/cancel`, { method: 'POST', body: {} });
    expect(again.statusCode).toBe(409);
    const e = err(again);
    expect(e.code).toBe('INVALID_STATE');
    expect(e.current_state).toBe('cancelled');
    expect(e.allowed_from).toContain('running');
  });

  it('cancel a running workflow run → eventually cancelled', async () => {
    m = mock({ tickMs: 30, defaultRunSteps: 30 });
    const res = await adhoc({
      steps: [{ id: 'l', type: 'loop', count: 50, body: [task('t', 'grind')] }],
    });
    const id = (res.json() as { id: string }).id;
    await waitFor(id, 'running');
    const cancel = await call(m, `/v1/workflows/runs/${id}/cancel`, { method: 'POST', body: {} });
    expect(cancel.statusCode).toBe(200);
    const run = await waitFor(id, 'cancelled');
    expect(run.status).toBe('cancelled');
  });

  it('workflow run resume requires a boolean approved field → 422', async () => {
    m = mock();
    const res = await adhoc({
      steps: [
        { id: 'gate', type: 'human_approval', message: 'ok?' },
        { id: 'ok', type: 'succeed' },
      ],
    });
    const id = (res.json() as { id: string }).id;
    await waitFor(id, 'awaiting_human');
    const bad = await call(m, `/v1/workflows/runs/${id}/resume`, {
      method: 'POST',
      body: { note: 'forgot approved' },
    });
    expect(bad.statusCode).toBe(422);
    expect(err(bad).code).toBe('VALIDATION_ERROR');
    // clean up the awaiting run so timers settle
    await call(m, `/v1/workflows/runs/${id}/resume`, { method: 'POST', body: { approved: true } });
    await waitFor(id, 'succeeded');
  });

  it('workflow run NOT_FOUND on get/cancel/resume/events for an unknown id', async () => {
    m = mock();
    for (const make of [
      () => call(m!, '/v1/workflows/runs/wfr_ghost'),
      () => call(m!, '/v1/workflows/runs/wfr_ghost/cancel', { method: 'POST', body: {} }),
      () => call(m!, '/v1/workflows/runs/wfr_ghost/resume', { method: 'POST', body: {} }),
      () => call(m!, '/v1/workflows/runs/wfr_ghost/events'),
    ]) {
      const res = await make();
      expect(res.statusCode).toBe(404);
      expect(err(res).code).toBe('NOT_FOUND');
    }
  });

  it('events SSE replay via ?after= query param (durable, ends at done)', async () => {
    m = mock({ tickMs: 25, defaultRunSteps: 2 });
    const machineId = await createMachine(m);
    const res = await call(m, '/v1/workflows/runs', {
      method: 'POST',
      body: {
        definition: { steps: [task('t', 'go', 'r'), { id: 'ok', type: 'succeed' }] },
        machine_id: machineId,
      },
    });
    const id = (res.json() as { id: string }).id;
    await waitFor(id, 'succeeded');
    // The full log is durable; reading with ?after=0 over inject replays all then ends.
    const stream = await call(m, `/v1/workflows/runs/${id}/events?after=0`);
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    const ids = [...stream.body.matchAll(/^id: (\d+)$/gm)].map((x) => Number(x[1]));
    expect(ids[0]).toBe(1);
    expect(stream.body).toContain('event: done');

    // ?after=N skips the first N events (no dupes, resumes at N+1).
    const cursor = 2;
    const partial = await call(m, `/v1/workflows/runs/${id}/events?after=${cursor}`);
    const partialIds = [...partial.body.matchAll(/^id: (\d+)$/gm)].map((x) => Number(x[1]));
    expect(partialIds[0]).toBe(cursor + 1);
    expect(partialIds.every((n) => n > cursor)).toBe(true);
    expect(partial.body).toContain('event: done');
  });

  it('run events SSE also honors ?after= for a finished run', async () => {
    m = mock({ defaultRunSteps: 2 });
    const machineId = await createMachine(m);
    const created = await call(m, '/v1/runs', {
      method: 'POST',
      body: { machine_id: machineId, task: 'short task' },
    });
    const id = (created.json() as { id: string }).id;
    await pollUntil(async () =>
      ((await call(m!, `/v1/runs/${id}`)).json() as { status: string }).status === 'succeeded'
        ? true
        : undefined,
    );
    const stream = await call(m, `/v1/runs/${id}/events?after=0`);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: done');
    const ids = [...stream.body.matchAll(/^id: (\d+)$/gm)].map((x) => Number(x[1]));
    expect(ids[0]).toBe(1);
  });
});

// ── 8. webhook signature helper round-trips with node:crypto HMAC ────────────

describe('buildSignature', () => {
  it('produces t=<unix>,v1=<hmacSha256Hex> that verifies with node:crypto', () => {
    const secret = 'whsec_deadbeef';
    const body = JSON.stringify({ event: 'run.succeeded', n: 1 });
    const ts = 1_700_000_000;
    const sig = buildSignature(secret, body, ts);
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=') as [string, string]));
    expect(parts.t).toBe(String(ts));
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(parts.v1).toBe(expected);
  });

  it('is deterministic for the same inputs and changes with the body (tamper-evident)', () => {
    const secret = 'whsec_abc';
    const body = '{"a":1}';
    const ts = 1_699_999_999;
    expect(buildSignature(secret, body, ts)).toBe(buildSignature(secret, body, ts));
    expect(buildSignature(secret, body, ts)).not.toBe(buildSignature(secret, `${body} `, ts));
    expect(buildSignature(secret, body, ts)).not.toBe(buildSignature(`${secret}x`, body, ts));
  });
});
