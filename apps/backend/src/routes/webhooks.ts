/**
 * Coasty webhook receiver. Every callback is authenticated by HMAC over the
 * RAW request body with the per-run webhook_secret (returned once at run
 * creation and held only in the backend DB): constant-time compare, ±5-minute
 * timestamp tolerance. Unverifiable callbacks are rejected — a webhook can
 * never mutate state without a valid signature.
 */
import type { FastifyInstance } from 'fastify';
import { verifyWebhookSignature, type Run, type WorkflowRun } from '@open-cowork/core';
import type { Db } from '../db';
import type { EventBus } from '../bus';

export interface WebhookRouteDeps {
  db: Db;
  bus: EventBus;
}

interface WebhookPayload {
  event?: string;
  run?: (Run | WorkflowRun) & { object?: string };
  created_at?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const { db, bus } = deps;

  app.post('/webhooks/coasty', async (request, reply) => {
    const raw = request.rawBody;
    const header = request.headers['coasty-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!raw || !signature) {
      return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Missing signature' } });
    }

    const payload = request.body as WebhookPayload;
    const upstream = payload.run;
    if (!upstream?.id || typeof payload.event !== 'string') {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Unrecognized payload' } });
    }

    // Locate the matching run (cloud run or workflow run) to find its secret.
    const isWorkflow = upstream.object === 'workflow.run' || payload.event.startsWith('workflow');
    const runRow = isWorkflow ? undefined : db.getRunByCoastyId(upstream.id);
    const wfRow = isWorkflow ? db.getWorkflowRunByCoastyId(upstream.id) : undefined;
    const secret = runRow?.webhook_secret ?? wfRow?.webhook_secret;
    if (!secret) {
      // Unknown run or no secret stored: refuse. (404 would leak which ids exist.)
      return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Unknown delivery' } });
    }

    const verdict = await verifyWebhookSignature({ body: raw, header: signature, secret });
    if (!verdict.valid) {
      return reply
        .status(401)
        .send({ error: { code: 'INVALID_SIGNATURE', message: `Signature rejected (${verdict.reason})` } });
    }

    // Verified: reconcile state + notify the owner's activity feed.
    const status = upstream.status;
    if (runRow) {
      db.updateRun(runRow.id, {
        status,
        ...(TERMINAL.has(status) ? { finished_at: new Date().toISOString() } : {}),
        ...('result' in upstream && upstream.result ? { result_json: JSON.stringify(upstream.result) } : {}),
        ...('cost_cents' in upstream && typeof upstream.cost_cents === 'number'
          ? { cost_cents: upstream.cost_cents }
          : {}),
        ...(status === 'awaiting_human' && 'awaiting_human_reason' in upstream
          ? { awaiting_human_reason: upstream.awaiting_human_reason }
          : {}),
      });
      notify(runRow.user_id, payload.event, { runId: runRow.id, status });
    } else if (wfRow) {
      db.updateWorkflowRun(wfRow.id, {
        status,
        ...(TERMINAL.has(status) ? { finished_at: new Date().toISOString() } : {}),
        ...('awaiting_step_id' in upstream ? { awaiting_step_id: upstream.awaiting_step_id } : {}),
        ...('spent_cents' in upstream && typeof upstream.spent_cents === 'number'
          ? { spent_cents: upstream.spent_cents }
          : {}),
      });
      notify(wfRow.user_id, payload.event, { workflowRunId: wfRow.id, status });
    }

    return reply.send({ received: true });
  });

  function notify(userId: string, type: string, data: Record<string, unknown>): void {
    const seq = db.appendEvent('notification', userId, type, data);
    bus.publish({
      streamKind: 'notification',
      streamId: userId,
      seq,
      type,
      data,
      userId,
      createdAt: new Date().toISOString(),
    });
  }
}
