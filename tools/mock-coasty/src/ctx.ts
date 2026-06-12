/** Shared context passed to the mock's route modules. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MockState, KeyKind } from './state';
import { sendError } from './util';

export interface MockOptions {
  /** Simulated prepaid wallet for live/legacy keys (cents). Default 10000. */
  walletCents: number;
  /** Run-stepper cadence in ms. Default 25 (fast for tests). */
  tickMs: number;
  /** Steps a default task takes before succeeding. Default 4. */
  defaultRunSteps: number;
  logger: boolean;
}

export interface Ctx {
  state: MockState;
  opts: MockOptions;
}

declare module 'fastify' {
  interface FastifyRequest {
    keyKind: KeyKind;
  }
}

/**
 * Charge a per-request fee. Test keys never debit (charged header = 0).
 * Returns false after sending 402 INSUFFICIENT_CREDITS when the wallet can't
 * cover it. Sets the documented billing headers on success.
 */
export function tryCharge(
  ctx: Ctx,
  request: FastifyRequest,
  reply: FastifyReply,
  family: string,
  credits: number,
): boolean {
  if (request.keyKind === 'test') {
    ctx.state.recordUsage(family, 0);
    void reply.header('X-Credits-Charged', '0');
    void reply.header('X-Credits-Remaining', String(ctx.state.walletCents));
    return true;
  }
  if (ctx.state.walletCents < credits) {
    sendError(
      reply,
      402,
      'INSUFFICIENT_CREDITS',
      `Operation needs ${credits} credits; you have ${ctx.state.walletCents}.`,
      {
        required: credits,
        balance: ctx.state.walletCents,
      },
    );
    return false;
  }
  ctx.state.walletCents -= credits;
  ctx.state.recordUsage(family, credits);
  void reply.header('X-Credits-Charged', String(credits));
  void reply.header('X-Credits-Remaining', String(ctx.state.walletCents));
  return true;
}

/** Debit used by background steppers (no HTTP reply). Returns false when dry. */
export function debitBackground(
  ctx: Ctx,
  isTest: boolean,
  family: string,
  credits: number,
): boolean {
  if (isTest) {
    ctx.state.recordUsage(family, 0);
    return true;
  }
  if (ctx.state.walletCents < credits) return false;
  ctx.state.walletCents -= credits;
  ctx.state.recordUsage(family, credits);
  return true;
}
