import { afterEach, describe, expect, it } from 'vitest';
import type { MockCoasty } from '../src/index';
import { parsePyautogui } from '../src/index';
import { call, LEGACY_KEY, LIVE_KEY, mock, SCREENSHOT, TEST_KEY } from './helpers';

let m: MockCoasty | null = null;
afterEach(async () => {
  await m?.app.close();
  m = null;
});

describe('auth matrix', () => {
  it.each([
    ['test', TEST_KEY],
    ['live', LIVE_KEY],
    ['legacy', LEGACY_KEY],
  ])('accepts a %s key and reports its kind', async (kind, key) => {
    m = mock();
    const res = await call(m, '/v1/models', { key });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-coasty-key-kind']).toBe(kind);
    expect(res.headers['x-coasty-request-id']).toMatch(/^req_/);
  });

  it('test keys carry X-Coasty-Test-Mode: true', async () => {
    m = mock();
    const res = await call(m, '/v1/models', { key: TEST_KEY });
    expect(res.headers['x-coasty-test-mode']).toBe('true');
  });

  it('rejects garbage / missing keys with the documented 401 envelope', async () => {
    m = mock();
    for (const key of ['nope', 'sk-coasty-prod-aaaa', null]) {
      const res = await call(m, '/v1/models', { key: key as string | null });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: { code: string; type: string; request_id: string } };
      expect(body.error.code).toBe('INVALID_API_KEY');
      expect(body.error.type).toBe('auth_error');
      expect(body.error.request_id).toMatch(/^req_/);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('accepts Authorization: Bearer', async () => {
    m = mock();
    const res = await m.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('predict pricing (documented surcharges, via a live key wallet)', () => {
  const predict = (body: Record<string, unknown>) =>
    call(m!, '/v1/predict', {
      method: 'POST',
      key: LIVE_KEY,
      body: {
        screenshot: SCREENSHOT,
        instruction: 'click the button',
        screen_width: 1280,
        screen_height: 720,
        ...body,
      },
    });

  it('base SD call: 5 credits', async () => {
    m = mock();
    const res = await predict({});
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-credits-charged']).toBe('5');
  });

  it('HD boundary: exactly 1280x720 is NOT HD; 1281x720 is (+1)', async () => {
    m = mock();
    expect(
      (await predict({ screen_width: 1280, screen_height: 720 })).headers['x-credits-charged'],
    ).toBe('5');
    expect(
      (await predict({ screen_width: 1281, screen_height: 720 })).headers['x-credits-charged'],
    ).toBe('6');
    expect(
      (await predict({ screen_width: 1280, screen_height: 721 })).headers['x-credits-charged'],
    ).toBe('6');
  });

  it('v1 engine +3; trajectory +2 each; long system_prompt +1 (500 exactly free)', async () => {
    m = mock();
    expect((await predict({ cua_version: 'v1' })).headers['x-credits-charged']).toBe('8');
    expect((await predict({ trajectory: [{}, {}] })).headers['x-credits-charged']).toBe('9');
    expect((await predict({ system_prompt: 'x'.repeat(500) })).headers['x-credits-charged']).toBe(
      '5',
    );
    expect((await predict({ system_prompt: 'x'.repeat(501) })).headers['x-credits-charged']).toBe(
      '6',
    );
  });

  it('test keys are charged 0 but get full responses', async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      key: TEST_KEY,
      body: { screenshot: SCREENSHOT, instruction: 'click' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-credits-charged']).toBe('0');
    expect((res.json() as { usage: { credits_charged: number } }).usage.credits_charged).toBe(0);
  });

  it('wallet debits accumulate and X-Credits-Remaining tracks them', async () => {
    m = mock({ walletCents: 20 });
    expect((await predict({})).headers['x-credits-remaining']).toBe('15');
    expect((await predict({})).headers['x-credits-remaining']).toBe('10');
  });

  it('402 INSUFFICIENT_CREDITS with required/balance when the wallet is short', async () => {
    m = mock({ walletCents: 3 });
    const res = await predict({});
    expect(res.statusCode).toBe(402);
    const body = res.json() as { error: { code: string; required: number; balance: number } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.error.required).toBe(5);
    expect(body.error.balance).toBe(3);
  });
});

describe('predict validation + scripting', () => {
  it('rejects data:-prefixed screenshots with INVALID_SCREENSHOT', async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      body: { screenshot: `data:image/png;base64,${SCREENSHOT}`, instruction: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_SCREENSHOT');
  });

  it('rejects empty instructions with VALIDATION_ERROR + details', async () => {
    m = mock();
    const res = await call(m, '/v1/predict', {
      method: 'POST',
      body: { screenshot: SCREENSHOT, instruction: '' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });

  it('MOCK_DONE / MOCK_FAIL / default scripting is deterministic', async () => {
    m = mock();
    const statusOf = async (instruction: string) =>
      (
        (
          await call(m!, '/v1/predict', {
            method: 'POST',
            body: { screenshot: SCREENSHOT, instruction },
          })
        ).json() as {
          status: string;
        }
      ).status;
    expect(await statusOf('finish up MOCK_DONE')).toBe('done');
    expect(await statusOf('hopeless MOCK_FAIL')).toBe('fail');
    expect(await statusOf('click the login button')).toBe('continue');
  });
});

describe('sessions', () => {
  it('full lifecycle: create (10cr) → predict steps (4cr) → done after N → delete frees', async () => {
    m = mock({ defaultRunSteps: 2 });
    // SD session (1280x720 exactly is NOT HD) so steps bill the base 4cr.
    const create = await call(m, '/v1/sessions', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screen_width: 1280, screen_height: 720 },
    });
    expect(create.statusCode).toBe(200);
    expect(create.headers['x-credits-charged']).toBe('10');
    const sessionId = (create.json() as { session_id: string }).session_id;
    expect(sessionId).toMatch(/^sess_/);

    const step = (instruction = 'click it') =>
      call(m!, `/v1/sessions/${sessionId}/predict`, {
        method: 'POST',
        key: LIVE_KEY,
        body: { screenshot: SCREENSHOT, instruction },
      });
    const first = await step();
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-credits-charged']).toBe('4');
    expect((first.json() as { status: string; step: number }).step).toBe(1);
    const second = await step();
    expect((second.json() as { status: string }).status).toBe('done'); // defaultRunSteps reached

    const info = await call(m, `/v1/sessions/${sessionId}`, { key: LIVE_KEY });
    expect((info.json() as { step_count: number }).step_count).toBe(2);

    const del = await call(m, `/v1/sessions/${sessionId}`, { method: 'DELETE', key: LIVE_KEY });
    expect((del.json() as { status: string }).status).toBe('ok');
    const after = await call(m, `/v1/sessions/${sessionId}`, { key: LIVE_KEY });
    expect(after.statusCode).toBe(404);
    expect((after.json() as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('ground / parse / models / usage', () => {
  it('ground bills 3 (+1 HD) and returns coordinates', async () => {
    m = mock();
    const res = await call(m, '/v1/ground', {
      method: 'POST',
      key: LIVE_KEY,
      body: {
        screenshot: SCREENSHOT,
        element: 'the blue Submit button',
        screen_width: 1280,
        screen_height: 720,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-credits-charged']).toBe('3');
    expect(res.json()).toMatchObject({ x: 512, y: 340 });
  });

  it('parse is free and deterministic', async () => {
    m = mock();
    const res = await call(m, '/v1/parse', {
      method: 'POST',
      body: {
        code: "pyautogui.click(100, 200)\npyautogui.typewrite('hi')\npyautogui.hotkey('ctrl', 'c')",
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { actions: unknown[] }).actions).toEqual([
      { action_type: 'click', params: { x: 100, y: 200 } },
      { action_type: 'type_text', params: { text: 'hi' } },
      { action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } },
    ]);
  });

  it('parsePyautogui handles press/scroll/moveTo variants', () => {
    expect(parsePyautogui("pyautogui.press('enter')")).toEqual([
      { action_type: 'key_press', params: { key: 'enter' } },
    ]);
    expect(parsePyautogui('pyautogui.scroll(-3)')).toEqual([
      { action_type: 'scroll', params: { clicks: -3 } },
    ]);
    expect(parsePyautogui('pyautogui.moveTo(5, 6)')).toEqual([
      { action_type: 'move', params: { x: 5, y: 6 } },
    ]);
  });

  it('models matches the documented payload shape', async () => {
    m = mock();
    const body = (await call(m, '/v1/models')).json() as {
      action_types: string[];
      cua_versions: { id: string }[];
    };
    expect(body.action_types).toContain('click');
    expect(body.cua_versions.map((v) => v.id)).toEqual(['v1', 'v3']);
  });

  it('usage accumulates credits across billed calls', async () => {
    m = mock();
    await call(m, '/v1/predict', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screenshot: SCREENSHOT, instruction: 'a' },
    });
    await call(m, '/v1/ground', {
      method: 'POST',
      key: LIVE_KEY,
      body: { screenshot: SCREENSHOT, element: 'b' },
    });
    const usage = (await call(m, '/v1/usage', { key: LIVE_KEY })).json() as {
      total_credits: number;
      wallet_balance_cents: number;
      breakdown: Record<string, { credits: number }>;
    };
    // Default dims are 1920x1080 (HD): predict 5+1=6, ground 3+1=4.
    expect(usage.total_credits).toBe(10);
    expect(usage.breakdown.predict?.credits).toBe(6);
    expect(usage.breakdown.ground?.credits).toBe(4);
  });
});
