/**
 * Workflow routes: CRUD proxied to Coasty (definitions validated locally with
 * core's validator first — instant feedback, no wasted round-trip), starting
 * runs with server-side budget caps + the confirmCostCents handshake, approvals
 * (resume {approved}), and SSE event timelines.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  validateWorkflowDefinition,
  workflowEstimateCents,
  type CoastyClient,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@open-cowork/core';
import type { BackendConfig } from '../config';
import type { Db, WorkflowRunRow } from '../db';
import type { EventBus } from '../bus';
import type { Ingestor } from '../ingest';
import { AppError, notFound } from '../errors';
import { streamSse } from '../sse';

export interface WorkflowRouteDeps {
  config: BackendConfig;
  db: Db;
  bus: EventBus;
  coasty: CoastyClient;
  ingestor: Ingestor;
}

interface WorkflowRunDto {
  id: string;
  workflowId: string | null;
  status: string;
  budgetCents: number;
  spentCents: number;
  awaitingStepId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function workflowRunToDto(row: WorkflowRunRow): WorkflowRunDto {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    budgetCents: row.budget_cents,
    spentCents: row.spent_cents,
    awaitingStepId: row.awaiting_step_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const { config, db, bus, coasty, ingestor } = deps;

  const assertValidDefinition = (definition: unknown): WorkflowDefinition => {
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {
      throw new AppError(422, 'INVALID_DEFINITION', 'Workflow definition failed validation', {
        issues: result.issues,
      });
    }
    return definition as WorkflowDefinition;
  };

  // ── CRUD (proxied) ──────────────────────────────────────────────────────────
  const createSchema = z.object({
    name: z.string().min(1).max(128),
    slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    definition: z.record(z.string(), z.unknown()),
    inputsSchema: z.record(z.string(), z.unknown()).nullish(),
    description: z.string().max(2000).nullish(),
  });
  app.post('/api/workflows', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const definition = assertValidDefinition(body.definition);
    const wf = await coasty.createWorkflow({
      name: body.name,
      slug: body.slug,
      definition,
      inputs_schema: body.inputsSchema ?? null,
      description: body.description ?? null,
    });
    void reply.status(201);
    return wf;
  });

  app.get('/api/workflows', async () => {
    const list = await coasty.listWorkflows({ limit: 100 });
    return { workflows: list.data };
  });

  // NB: static '/api/workflows/runs' routes are registered BEFORE the dynamic
  // '/api/workflows/:id' ones (mirroring the documented Coasty route order).
  const startSchema = z.object({
    inputs: z.record(z.string(), z.unknown()).optional(),
    machineId: z.string().min(1).max(128).optional(),
    budgetCents: z.number().int().min(1).optional(),
    maxIterations: z.number().int().min(1).max(100000).optional(),
    deadlineSeconds: z.number().int().min(1).max(86400).optional(),
    confirmCostCents: z.number().int(),
    /** Ad-hoc runs only. */
    definition: z.record(z.string(), z.unknown()).optional(),
  });

  async function startRun(
    request: { user: { id: string; budget_cents: number } },
    body: z.infer<typeof startSchema>,
    workflowId: string | null,
    definition: WorkflowDefinition,
  ): Promise<WorkflowRunDto> {
    const budget = Math.min(body.budgetCents ?? request.user.budget_cents, request.user.budget_cents);
    // The handshake confirms the CAP the user is approving (the hard ceiling
    // Coasty enforces via budget_cents), not a guess at the typical cost.
    if (body.confirmCostCents !== budget) {
      const estimate = workflowEstimateCents(definition);
      throw new AppError(409, 'ESTIMATE_CHANGED', 'Confirm the budget cap for this workflow run', {
        expectedCents: budget,
        typicalCents: estimate.typicalCents,
        worstCaseCents: estimate.worstCaseCents,
      });
    }

    const startReq = {
      inputs: body.inputs ?? null,
      machine_id: body.machineId ?? null,
      budget_cents: budget,
      max_iterations: body.maxIterations ?? null,
      deadline_seconds: body.deadlineSeconds ?? null,
      webhook_url: `${config.publicUrl}/webhooks/coasty`,
      ...(workflowId === null ? { definition } : {}),
    };
    const run: WorkflowRun = workflowId
      ? await coasty.startWorkflowRun(workflowId, startReq, { idempotencyKey: `cwk-wfr-${randomUUID()}` })
      : await coasty.startAdhocWorkflowRun(startReq, { idempotencyKey: `cwk-wfr-${randomUUID()}` });

    const row: WorkflowRunRow = {
      id: `wr_${randomUUID().slice(0, 12)}`,
      user_id: request.user.id,
      coasty_workflow_run_id: run.id,
      workflow_id: run.workflow_id,
      status: run.status,
      budget_cents: budget,
      spent_cents: run.spent_cents,
      awaiting_step_id: run.awaiting_step_id,
      webhook_secret: run.webhook_secret ?? null,
      created_at: new Date().toISOString(),
      finished_at: null,
    };
    db.insertWorkflowRun(row);
    ingestor.start({ kind: 'workflow-run', localId: row.id, coastyId: run.id, userId: request.user.id });
    const seq = db.appendEvent('notification', request.user.id, 'workflow_run.created', { workflowRunId: row.id });
    bus.publish({
      streamKind: 'notification',
      streamId: request.user.id,
      seq,
      type: 'workflow_run.created',
      data: { workflowRunId: row.id },
      userId: request.user.id,
      createdAt: new Date().toISOString(),
    });
    return workflowRunToDto(row);
  }

  app.post('/api/workflows/runs', async (request, reply) => {
    const body = startSchema.parse(request.body);
    if (!body.definition) {
      throw new AppError(400, 'BAD_REQUEST', 'Ad-hoc workflow runs require a definition');
    }
    const definition = assertValidDefinition(body.definition);
    void reply.status(201);
    return startRun(request, body, null, definition);
  });

  app.get('/api/workflows/runs', async (request) => {
    return { runs: db.listWorkflowRuns(request.user.id).map(workflowRunToDto) };
  });

  app.get('/api/workflows/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getWorkflowRun(request.user.id, id);
    if (!row) throw notFound('Workflow run');
    // Reconcile with upstream for output/error fields we don't mirror.
    try {
      const run = await coasty.getWorkflowRun(row.coasty_workflow_run_id);
      return { ...workflowRunToDto(row), status: run.status, output: run.output, error: run.error,
        spentCents: run.spent_cents, awaitingStepId: run.awaiting_step_id, awaitingReason: run.awaiting_human_reason };
    } catch {
      return workflowRunToDto(row);
    }
  });

  app.post('/api/workflows/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.getWorkflowRun(request.user.id, id);
    if (!row) throw notFound('Workflow run');
    const run = await coasty.cancelWorkflowRun(row.coasty_workflow_run_id);
    db.updateWorkflowRun(id, { status: run.status, finished_at: new Date().toISOString() });
    return workflowRunToDto(db.getWorkflowRun(request.user.id, id)!);
  });

  const resumeSchema = z.object({ approved: z.boolean(), note: z.string().max(2000).optional() });
  app.post('/api/workflows/runs/:id/resume', async (request) => {
    const { id } = request.params as { id: string };
    const body = resumeSchema.parse(request.body);
    const row = db.getWorkflowRun(request.user.id, id);
    if (!row) throw notFound('Workflow run');
    const run = await coasty.resumeWorkflowRun(row.coasty_workflow_run_id, {
      approved: body.approved,
      note: body.note,
    });
    db.updateWorkflowRun(id, { status: run.status, awaiting_step_id: run.awaiting_step_id });
    return workflowRunToDto(db.getWorkflowRun(request.user.id, id)!);
  });

  app.get('/api/workflows/runs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.getWorkflowRun(request.user.id, id);
    if (!row) throw notFound('Workflow run');
    streamSse(request, reply, { db, bus, streamKind: 'workflow-run', streamId: id, closeOnType: 'done' });
  });

  // ── dynamic id routes AFTER the static /runs subtree ───────────────────────
  app.get('/api/workflows/:id', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.getWorkflow(id);
  });

  const updateSchema = z.object({
    name: z.string().min(1).max(128).optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
    inputsSchema: z.record(z.string(), z.unknown()).nullish(),
    description: z.string().max(2000).nullish(),
    status: z.enum(['active', 'archived']).optional(),
  });
  app.put('/api/workflows/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);
    const definition = body.definition ? assertValidDefinition(body.definition) : undefined;
    return coasty.updateWorkflow(id, {
      name: body.name,
      definition,
      inputs_schema: body.inputsSchema,
      description: body.description,
      status: body.status,
    });
  });

  app.delete('/api/workflows/:id', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.deleteWorkflow(id);
  });

  app.post('/api/workflows/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = startSchema.parse(request.body);
    const wf = await coasty.getWorkflow(id);
    const definition = assertValidDefinition(wf.definition);
    void reply.status(201);
    return startRun(request, body, id, definition);
  });

  // Local-only validation endpoint for the builder UI (free, instant).
  const validateSchema = z.object({ definition: z.record(z.string(), z.unknown()) });
  app.post('/api/workflows/validate', async (request) => {
    const body = validateSchema.parse(request.body);
    const result = validateWorkflowDefinition(body.definition);
    const estimate = result.valid
      ? workflowEstimateCents(body.definition as unknown as WorkflowDefinition)
      : null;
    return { valid: result.valid, issues: result.issues, estimate };
  });
}
