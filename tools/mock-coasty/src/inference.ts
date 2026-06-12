/**
 * Core inference routes: /predict, /sessions*, /ground, /parse, /models,
 * /usage — deterministic scripted behavior, documented pricing.
 */
import type { FastifyInstance } from 'fastify';
import { tryCharge, type Ctx } from './ctx';
import { hex, nowIso, requestId, sendError } from './util';
import type { SessionRec } from './state';

interface PredictBody {
  screenshot?: unknown;
  instruction?: unknown;
  cua_version?: string;
  system_prompt?: string | null;
  trajectory?: unknown[];
  screen_width?: number;
  screen_height?: number;
}

function surcharges(body: PredictBody): number {
  let extra = 0;
  extra += (body.trajectory?.length ?? 0) * 2;
  if ((body.screen_width ?? 1920) > 1280 || (body.screen_height ?? 1080) > 720) extra += 1;
  if (body.cua_version === 'v1') extra += 3;
  if ((body.system_prompt?.length ?? 0) > 500) extra += 1;
  return extra;
}

function validateScreenshotAndInstruction(
  body: PredictBody,
):
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; extras?: Record<string, unknown> } {
  if (typeof body.screenshot !== 'string' || body.screenshot.length <= 100) {
    return {
      ok: false,
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'screenshot must be a base64 string longer than 100 chars',
      extras: { details: [{ loc: ['body', 'screenshot'], type: 'string' }] },
    };
  }
  if (body.screenshot.startsWith('data:')) {
    return {
      ok: false,
      status: 422,
      code: 'INVALID_SCREENSHOT',
      message: 'screenshot is not decodable base64 (strip the data: prefix)',
    };
  }
  if (typeof body.instruction !== 'string' || body.instruction.length === 0) {
    return {
      ok: false,
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'instruction must be a non-empty string',
      extras: { details: [{ loc: ['body', 'instruction'], type: 'string' }] },
    };
  }
  return { ok: true };
}

/** Scripted, deterministic predict result driven by the instruction text. */
function scriptedPrediction(instruction: string): {
  status: 'continue' | 'done' | 'fail';
  actions: Record<string, unknown>[];
  reasoning: string;
} {
  if (instruction.includes('MOCK_DONE')) {
    return {
      status: 'done',
      actions: [{ action_type: 'done', params: {}, description: 'Task complete' }],
      reasoning: 'The task is already complete.',
    };
  }
  if (instruction.includes('MOCK_FAIL')) {
    return {
      status: 'fail',
      actions: [
        {
          action_type: 'fail',
          params: { reason: 'mock failure requested' },
          description: 'Cannot proceed',
        },
      ],
      reasoning: 'The task cannot be completed.',
    };
  }
  if (instruction.toLowerCase().includes('type:')) {
    const text = instruction.split(/type:/i)[1]?.trim() ?? 'hello';
    return {
      status: 'continue',
      actions: [{ action_type: 'type_text', params: { text }, description: `Type "${text}"` }],
      reasoning: 'Typing the requested text.',
    };
  }
  return {
    status: 'continue',
    actions: [
      { action_type: 'click', params: { x: 512, y: 340 }, description: 'Click the target element' },
    ],
    reasoning: 'The target is visible; clicking it.',
  };
}

export function registerInferenceRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/v1/predict', async (request, reply) => {
    const body = (request.body ?? {}) as PredictBody;
    const valid = validateScreenshotAndInstruction(body);
    if (!valid.ok) return sendError(reply, valid.status, valid.code, valid.message, valid.extras);
    const credits = 5 + surcharges(body);
    if (!tryCharge(ctx, request, reply, 'predict', credits)) return reply;
    const scripted = scriptedPrediction(body.instruction as string);
    return {
      request_id: requestId(),
      status: scripted.status,
      reasoning: scripted.reasoning,
      actions: scripted.actions,
      raw_code: ['pyautogui.click(512, 340)'],
      usage: {
        input_tokens: 1500,
        output_tokens: 200,
        credits_charged: request.keyKind === 'test' ? 0 : credits,
        cost_cents: request.keyKind === 'test' ? 0 : credits,
      },
    };
  });

  app.post('/v1/sessions', async (request, reply) => {
    if (!tryCharge(ctx, request, reply, 'sessions', 10)) return reply;
    const body = (request.body ?? {}) as PredictBody;
    const rec: SessionRec = {
      session_id: `sess_${hex(6)}`,
      cua_version: body.cua_version ?? 'v3',
      screen_width: body.screen_width ?? 1920,
      screen_height: body.screen_height ?? 1080,
      step_count: 0,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      total_credits_used: 10,
    };
    ctx.state.sessions.set(rec.session_id, rec);
    return {
      session_id: rec.session_id,
      cua_version: rec.cua_version,
      screen_size: `${rec.screen_width}x${rec.screen_height}`,
      created_at: rec.created_at,
      expires_at: rec.expires_at,
    };
  });

  app.post('/v1/sessions/:id/predict', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = ctx.state.sessions.get(id);
    if (!session)
      return sendError(reply, 404, 'SESSION_NOT_FOUND', `No session '${id}' for this key`);
    const body = (request.body ?? {}) as PredictBody;
    const valid = validateScreenshotAndInstruction(body);
    if (!valid.ok) return sendError(reply, valid.status, valid.code, valid.message, valid.extras);
    const credits =
      4 +
      surcharges({
        ...body,
        screen_width: session.screen_width,
        screen_height: session.screen_height,
      });
    if (!tryCharge(ctx, request, reply, 'sessions', credits)) return reply;
    session.step_count++;
    session.total_credits_used += credits;
    const scripted =
      session.step_count >= ctx.opts.defaultRunSteps
        ? scriptedPrediction(`${body.instruction as string} MOCK_DONE`)
        : scriptedPrediction(body.instruction as string);
    return {
      request_id: requestId(),
      session_id: id,
      step: session.step_count,
      actions: scripted.actions,
      raw_code: [],
      reasoning: scripted.reasoning,
      status: scripted.status,
      usage: {
        input_tokens: 1200,
        output_tokens: 150,
        credits_charged: request.keyKind === 'test' ? 0 : credits,
        cost_cents: request.keyKind === 'test' ? 0 : credits,
      },
    };
  });

  app.post('/v1/sessions/:id/reset', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = ctx.state.sessions.get(id);
    if (!session)
      return sendError(reply, 404, 'SESSION_NOT_FOUND', `No session '${id}' for this key`);
    session.step_count = 0;
    return { status: 'ok', session_id: id };
  });

  app.get('/v1/sessions', async () => {
    return { sessions: [...ctx.state.sessions.values()].map(sessionInfo) };
  });

  app.get('/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = ctx.state.sessions.get(id);
    if (!session)
      return sendError(reply, 404, 'SESSION_NOT_FOUND', `No session '${id}' for this key`);
    return sessionInfo(session);
  });

  app.delete('/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.state.sessions.delete(id)) {
      return sendError(reply, 404, 'SESSION_NOT_FOUND', `No session '${id}' for this key`);
    }
    return { status: 'ok', session_id: id };
  });

  app.post('/v1/ground', async (request, reply) => {
    const body = (request.body ?? {}) as PredictBody & { element?: unknown };
    if (typeof body.screenshot !== 'string' || body.screenshot.length <= 100) {
      return sendError(
        reply,
        422,
        'VALIDATION_ERROR',
        'screenshot must be a base64 string longer than 100 chars',
      );
    }
    if (typeof body.element !== 'string' || body.element.length === 0) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'element must be a non-empty string');
    }
    const hd = (body.screen_width ?? 1920) > 1280 || (body.screen_height ?? 1080) > 720 ? 1 : 0;
    const credits = 3 + hd;
    if (!tryCharge(ctx, request, reply, 'ground', credits)) return reply;
    return {
      x: 512,
      y: 340,
      usage: {
        credits_charged: request.keyKind === 'test' ? 0 : credits,
        cost_cents: request.keyKind === 'test' ? 0 : credits,
      },
    };
  });

  app.post('/v1/parse', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown };
    if (typeof body.code !== 'string' || body.code.length === 0 || body.code.length >= 50_000) {
      return sendError(
        reply,
        422,
        'VALIDATION_ERROR',
        'code must be a non-empty string under 50,000 chars',
      );
    }
    ctx.state.recordUsage('parse', 0);
    return { actions: parsePyautogui(body.code) };
  });

  app.get('/v1/models', async () => ({
    models: [{ id: 'default', description: 'Default model - balanced performance and cost' }],
    cua_versions: [
      {
        id: 'v1',
        description:
          'Baseline - single action per call, reflection enabled, 8-screenshot trajectory',
        avg_step_time: '9-10s',
        features: ['reflection', 'single_action'],
      },
      {
        id: 'v3',
        description: 'Lean - multi-action per call, no reflection, aggressive compaction',
        avg_step_time: '3.5-4s',
        features: ['multi_action', 'compaction'],
      },
    ],
    action_types: [
      'click',
      'type_text',
      'key_press',
      'key_combo',
      'scroll',
      'drag',
      'move',
      'wait',
      'done',
      'fail',
    ],
  }));

  app.get('/v1/usage', async (request) => {
    const query = request.query as { period?: string };
    return {
      period: query.period ?? nowIso().slice(0, 7),
      total_requests: ctx.state.usage.totalRequests,
      total_credits: ctx.state.usage.totalCredits,
      total_cost_cents: ctx.state.usage.totalCredits,
      breakdown: ctx.state.usage.breakdown,
      balance: ctx.state.walletCents,
      wallet_balance_cents: ctx.state.walletCents,
      wallet_balance_usd: ctx.state.walletCents / 100,
    };
  });
}

function sessionInfo(s: SessionRec): Record<string, unknown> {
  return {
    session_id: s.session_id,
    cua_version: s.cua_version,
    screen_size: `${s.screen_width}x${s.screen_height}`,
    step_count: s.step_count,
    created_at: s.created_at,
    expires_at: s.expires_at,
    total_credits_used: s.total_credits_used,
  };
}

/** Deterministic pyautogui parser (the documented /parse is free + model-less). */
export function parsePyautogui(code: string): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [];
  const lines = code.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^pyautogui\.click\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/))) {
      actions.push({ action_type: 'click', params: { x: Number(m[1]), y: Number(m[2]) } });
    } else if ((m = line.match(/^pyautogui\.doubleClick\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/))) {
      actions.push({
        action_type: 'click',
        params: { x: Number(m[1]), y: Number(m[2]), clicks: 2 },
      });
    } else if ((m = line.match(/^pyautogui\.rightClick\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/))) {
      actions.push({
        action_type: 'click',
        params: { x: Number(m[1]), y: Number(m[2]), button: 'right' },
      });
    } else if (
      (m = line.match(/^pyautogui\.(?:typewrite|write)\(\s*'([^']*)'/)) ||
      (m = line.match(/^pyautogui\.(?:typewrite|write)\(\s*"([^"]*)"/))
    ) {
      actions.push({ action_type: 'type_text', params: { text: m[1] } });
    } else if ((m = line.match(/^pyautogui\.press\(\s*'([^']*)'\s*\)/))) {
      actions.push({ action_type: 'key_press', params: { key: m[1] } });
    } else if ((m = line.match(/^pyautogui\.hotkey\(\s*(.+)\s*\)/))) {
      const keys = [...m[1]!.matchAll(/'([^']*)'/g)].map((k) => k[1]);
      actions.push({ action_type: 'key_combo', params: { keys } });
    } else if ((m = line.match(/^pyautogui\.scroll\(\s*(-?\d+)\s*\)/))) {
      actions.push({ action_type: 'scroll', params: { clicks: Number(m[1]) } });
    } else if ((m = line.match(/^pyautogui\.moveTo\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/))) {
      actions.push({ action_type: 'move', params: { x: Number(m[1]), y: Number(m[2]) } });
    } else if ((m = line.match(/^pyautogui\.dragTo\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/))) {
      actions.push({ action_type: 'drag', params: { x2: Number(m[1]), y2: Number(m[2]) } });
    }
  }
  return actions;
}
