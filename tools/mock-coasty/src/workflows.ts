/**
 * Workflows: versioned CRUD + an async DSL interpreter with the documented
 * semantics — task billing against budget_cents, the 13 condition ops,
 * {{templating}}, loops with max_iterations, parallel branches, retries
 * (MUST_FAIL_ONCE recovers), human_approval pause/resume, and SSE + webhooks.
 * Deliberately independent of @open-cowork/core (DECISIONS.md D9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { debitBackground, type Ctx } from './ctx';
import { bodyHash, hex, nowIso, requestId, sendError } from './util';
import type { WorkflowRec, WorkflowRunRec } from './state';
import { streamEvents } from './sseRoute';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STEP_TYPES = new Set(['task', 'assert', 'if', 'loop', 'parallel', 'human_approval', 'retry', 'succeed', 'fail']);
const OPS = new Set(['eq', 'ne', 'lt', 'gt', 'lte', 'gte', 'contains', 'truthy', 'falsy', 'exists', 'and', 'or', 'not']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

type Step = Record<string, unknown> & { id?: string; type?: string };
type Scope = Record<string, unknown>;

// ── validation (documented limits) ─────────────────────────────────────────────

export function validateDefinition(definition: unknown): string[] {
  const issues: string[] = [];
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return ['definition must be an object'];
  }
  const steps = (definition as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['definition.steps must be a non-empty array'];

  const seen = new Set<string>();
  let total = 0;

  const walkCondition = (cond: unknown, path: string): void => {
    if (cond === null || typeof cond !== 'object') {
      issues.push(`${path}: condition must be an object`);
      return;
    }
    const c = cond as { op?: unknown; conditions?: unknown; condition?: unknown };
    if (typeof c.op !== 'string' || !OPS.has(c.op)) {
      issues.push(`${path}: unknown condition op '${String(c.op)}'`);
      return;
    }
    if ((c.op === 'and' || c.op === 'or') && Array.isArray(c.conditions)) {
      c.conditions.forEach((sub, i) => walkCondition(sub, `${path}.conditions[${i}]`));
    }
    if (c.op === 'not' && c.condition !== undefined) walkCondition(c.condition, `${path}.condition`);
  };

  const walk = (list: unknown[], path: string, depth: number, inParallel: boolean): void => {
    if (depth > 8) {
      issues.push(`${path}: steps nest at most 8 levels deep`);
      return;
    }
    list.forEach((raw, i) => {
      total++;
      const p = `${path}[${i}]`;
      const step = raw as Step;
      if (typeof step.id !== 'string' || !ID_RE.test(step.id)) issues.push(`${p}.id: invalid step id`);
      else if (seen.has(step.id)) issues.push(`${p}.id: duplicate step id '${step.id}'`);
      else seen.add(step.id);
      if (typeof step.type !== 'string' || !STEP_TYPES.has(step.type)) {
        issues.push(`${p}.type: unknown step type '${String(step.type)}'`);
        return;
      }
      if (inParallel && ['human_approval', 'succeed', 'fail'].includes(step.type)) {
        issues.push(`${p}: '${step.type}' is not allowed inside a parallel branch`);
      }
      switch (step.type) {
        case 'task':
          if (typeof step.task !== 'string' || step.task.length === 0) issues.push(`${p}.task: required`);
          if (step.save_as !== undefined && ['inputs', 'vars'].includes(String(step.save_as))) {
            issues.push(`${p}.save_as: '${String(step.save_as)}' is a reserved namespace`);
          }
          break;
        case 'assert':
          if (step.condition === undefined) issues.push(`${p}.condition: required`);
          else walkCondition(step.condition, `${p}.condition`);
          break;
        case 'if':
          if (step.condition === undefined) issues.push(`${p}.condition: required`);
          else walkCondition(step.condition, `${p}.condition`);
          if (!Array.isArray(step.then)) issues.push(`${p}.then: required`);
          else walk(step.then, `${p}.then`, depth + 1, inParallel);
          if (step.else !== undefined && Array.isArray(step.else)) walk(step.else, `${p}.else`, depth + 1, inParallel);
          break;
        case 'loop': {
          const hasCount = step.count !== undefined;
          const hasWhile = step.while !== undefined;
          if (hasCount === hasWhile) issues.push(`${p}: loop requires exactly one of count | while`);
          if (hasWhile) walkCondition(step.while, `${p}.while`);
          if (!Array.isArray(step.body)) issues.push(`${p}.body: required`);
          else walk(step.body, `${p}.body`, depth + 1, inParallel);
          break;
        }
        case 'parallel': {
          const branches = step.branches;
          if (!Array.isArray(branches) || branches.length === 0) {
            issues.push(`${p}.branches: required`);
            break;
          }
          if (branches.length > 16) issues.push(`${p}.branches: at most 16 branches`);
          branches.forEach((branch, b) => {
            if (Array.isArray(branch)) walk(branch, `${p}.branches[${b}]`, depth + 1, true);
          });
          break;
        }
        case 'retry': {
          const attempts = step.max_attempts;
          if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
            issues.push(`${p}.max_attempts: must be an integer 1-20`);
          }
          if (!Array.isArray(step.body)) issues.push(`${p}.body: required`);
          else walk(step.body, `${p}.body`, depth + 1, inParallel);
          break;
        }
        default:
          break;
      }
    });
  };
  walk(steps, 'steps', 1, false);
  if (total > 200) issues.push(`steps: at most 200 steps total (got ${total})`);
  return issues;
}

// ── templating + conditions ────────────────────────────────────────────────────

function resolvePath(path: string, scope: Scope): unknown {
  let cur: unknown = scope;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function resolveTemplate(value: unknown, scope: Scope): unknown {
  if (typeof value !== 'string') return value;
  const full = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
  if (full) return resolvePath(full[1]!, scope);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, p: string) => {
    const v = resolvePath(p, scope);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function resolveDeep(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return resolveTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, scope);
    return out;
  }
  return value;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function evalCondition(cond: Record<string, unknown>, scope: Scope): boolean {
  const op = cond.op as string;
  const left = () => resolveTemplate(cond.left, scope);
  const right = () => resolveTemplate(cond.right, scope);
  switch (op) {
    case 'eq':
      return JSON.stringify(left()) === JSON.stringify(right());
    case 'ne':
      return JSON.stringify(left()) !== JSON.stringify(right());
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const l = num(left());
      const r = num(right());
      if (l === undefined || r === undefined) return false;
      if (op === 'lt') return l < r;
      if (op === 'gt') return l > r;
      if (op === 'lte') return l <= r;
      return l >= r;
    }
    case 'contains': {
      const l = left();
      const r = right();
      if (typeof l === 'string') return l.includes(String(r));
      if (Array.isArray(l)) return l.some((x) => JSON.stringify(x) === JSON.stringify(r));
      return false;
    }
    case 'truthy':
      return Boolean(resolveTemplate(cond.value, scope));
    case 'falsy':
      return !resolveTemplate(cond.value, scope);
    case 'exists': {
      const v = resolveTemplate(cond.value, scope);
      return v !== undefined && v !== null;
    }
    case 'and':
      return (cond.conditions as Record<string, unknown>[]).every((c) => evalCondition(c, scope));
    case 'or':
      return (cond.conditions as Record<string, unknown>[]).some((c) => evalCondition(c, scope));
    case 'not':
      return !evalCondition(cond.condition as Record<string, unknown>, scope);
    default:
      return false;
  }
}

// ── interpreter ────────────────────────────────────────────────────────────────

class Terminated {
  constructor(
    readonly status: string,
    readonly output?: Record<string, unknown>,
    readonly error?: { code: string; message: string },
  ) {}
}

export function publicWorkflowRun(run: WorkflowRunRec, includeSecret: boolean): Record<string, unknown> {
  return {
    id: run.id,
    object: run.object,
    status: run.status,
    workflow_id: run.workflow_id,
    workflow_version: run.workflow_version,
    machine_id: run.machine_id,
    inputs: run.inputs,
    output: run.output,
    error: run.error,
    awaiting_human_reason: run.awaiting_human_reason,
    awaiting_step_id: run.awaiting_step_id,
    iterations_used: run.iterations_used,
    spent_cents: run.spent_cents,
    budget_cents: run.budget_cents,
    webhook_url: run.webhook_url,
    webhook_secret: includeSecret ? run.webhook_secret : null,
    metadata: run.metadata,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    request_id: run.request_id,
  };
}

export function registerWorkflowRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { state, opts } = ctx;
  const failOnceMemo = new Map<string, number>();

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function executeRun(run: WorkflowRunRec, isTest: boolean): Promise<void> {
    const scope: Scope = { inputs: run.inputs, vars: {} };
    run.status = 'running';
    run.started_at = nowIso();
    state.emit(run.id, 'status', { status: 'running' });

    const checkAbort = (): void => {
      if (run.cancelled) throw new Terminated('cancelled');
      if (run.deadlineAt !== null && Date.now() > run.deadlineAt) throw new Terminated('timed_out');
    };

    const guard = (maxIterations: number | null): void => {
      if (run.budget_cents > 0 && run.spent_cents > run.budget_cents) {
        throw new Terminated('failed', undefined, {
          code: 'GUARD_EXCEEDED',
          message: `budget_cents exceeded: ${run.spent_cents} > ${run.budget_cents}`,
        });
      }
      if (maxIterations !== null && run.iterations_used > maxIterations) {
        throw new Terminated('failed', undefined, {
          code: 'GUARD_EXCEEDED',
          message: `max_iterations exceeded: ${run.iterations_used} > ${maxIterations}`,
        });
      }
    };

    const maxIterations = (run.metadata?.__max_iterations as number | null) ?? null;

    async function runTask(step: Step): Promise<void> {
      const resolved = String(resolveTemplate(step.task, scope));
      state.emit(run.id, 'text', { text: `Task '${step.id}': ${resolved}` });
      let passed = true;
      // MUST_FAIL_ONCE: fails on the first attempt of this step id, then passes.
      if (resolved.includes('MUST_FAIL_ONCE')) {
        const attempts = (failOnceMemo.get(`${run.id}:${step.id}`) ?? 0) + 1;
        failOnceMemo.set(`${run.id}:${step.id}`, attempts);
        passed = attempts >= 2;
      } else if (resolved.includes('MUST_FAIL')) {
        passed = false;
      }
      for (let mini = 0; mini < opts.defaultRunSteps; mini++) {
        checkAbort();
        if (!debitBackground(ctx, isTest, 'workflows', 5)) {
          throw new Terminated('failed', undefined, { code: 'WALLET_EXHAUSTED', message: 'Wallet ran dry mid-workflow' });
        }
        if (!isTest) run.spent_cents += 5;
        else run.spent_cents += 0;
        await sleep(opts.tickMs);
        guard(maxIterations);
      }
      // Test keys still need observable spend for budget UIs; bill virtually.
      if (isTest) run.spent_cents += opts.defaultRunSteps * 5;
      guard(maxIterations);
      const binding = {
        status: passed ? 'succeeded' : 'failed',
        passed,
        result: `Task completed: ${resolved}`,
        run_id: `run_${hex(4)}`,
        steps: opts.defaultRunSteps,
        error: passed ? null : { code: 'VERIFICATION_FAILED', message: 'Task verification failed' },
      };
      scope[step.id as string] = binding;
      if (typeof step.save_as === 'string') scope[step.save_as] = binding;
      state.emit(run.id, 'step', { step_id: step.id, passed });
      state.emit(run.id, 'billing', { spent_cents: run.spent_cents });
    }

    async function execSteps(steps: Step[]): Promise<void> {
      for (const step of steps) {
        checkAbort();
        guard(maxIterations);
        switch (step.type) {
          case 'task':
            await runTask(step);
            break;
          case 'assert':
            if (!evalCondition(step.condition as Record<string, unknown>, scope)) {
              throw new Terminated('failed', undefined, {
                code: 'ASSERTION_FAILED',
                message: (step.message as string) ?? `Assertion '${step.id}' failed`,
              });
            }
            break;
          case 'if':
            if (evalCondition(step.condition as Record<string, unknown>, scope)) {
              await execSteps(step.then as Step[]);
            } else if (Array.isArray(step.else)) {
              await execSteps(step.else as Step[]);
            }
            break;
          case 'loop': {
            if (typeof step.count === 'number') {
              for (let i = 0; i < step.count; i++) {
                run.iterations_used++;
                guard(maxIterations);
                await execSteps(step.body as Step[]);
              }
            } else {
              while (evalCondition(step.while as Record<string, unknown>, scope)) {
                run.iterations_used++;
                guard(maxIterations);
                if (typeof step.max_iterations === 'number' && run.iterations_used > step.max_iterations) break;
                await execSteps(step.body as Step[]);
              }
            }
            break;
          }
          case 'parallel':
            await Promise.all((step.branches as Step[][]).map((branch) => execSteps(branch)));
            break;
          case 'retry': {
            const max = step.max_attempts as number;
            let lastErr: unknown;
            let done = false;
            for (let attempt = 1; attempt <= max && !done; attempt++) {
              try {
                await execSteps(step.body as Step[]);
                done = true;
              } catch (err) {
                if (err instanceof Terminated && err.status !== 'failed') throw err;
                lastErr = err;
              }
            }
            if (!done) {
              throw lastErr instanceof Terminated
                ? lastErr
                : new Terminated('failed', undefined, { code: 'RETRY_EXHAUSTED', message: `retry '${step.id}' exhausted` });
            }
            break;
          }
          case 'human_approval': {
            const message = step.message !== undefined ? String(resolveTemplate(step.message, scope)) : 'Approval required';
            run.status = 'awaiting_human';
            run.awaiting_step_id = step.id as string;
            run.awaiting_human_reason = message;
            state.emit(run.id, 'awaiting_human', { step_id: step.id, reason: message });
            state.emit(run.id, 'status', { status: 'awaiting_human' });
            if (run.webhook_url && run.webhook_secret) {
              void state.deliverWebhook(run.webhook_url, run.webhook_secret, 'workflow_run.awaiting_human', {
                run: publicWorkflowRun(run, false),
              });
            }
            const decision = await new Promise<{ approved: boolean; note?: string }>((resolve) => {
              run.approvalResolve = resolve;
            });
            run.approvalResolve = null;
            run.awaiting_step_id = null;
            run.awaiting_human_reason = null;
            checkAbort();
            run.status = 'running';
            state.emit(run.id, 'resumed', { approved: decision.approved, note: decision.note ?? null });
            state.emit(run.id, 'status', { status: 'running' });
            if (!decision.approved) {
              throw new Terminated('failed', undefined, {
                code: 'APPROVAL_REJECTED',
                message: decision.note ?? `Approval '${step.id}' was rejected`,
              });
            }
            break;
          }
          case 'succeed':
            throw new Terminated('succeeded', step.output ? (resolveDeep(step.output, scope) as Record<string, unknown>) : undefined);
          case 'fail':
            throw new Terminated('failed', undefined, {
              code: 'WORKFLOW_FAILED',
              message: step.message !== undefined ? String(resolveTemplate(step.message, scope)) : 'Workflow failed',
            });
          default:
            break;
        }
      }
    }

    let terminal: Terminated;
    try {
      await execSteps((run.definitionSnapshot.steps as Step[]) ?? []);
      const output = run.definitionSnapshot.output
        ? (resolveDeep(run.definitionSnapshot.output, scope) as Record<string, unknown>)
        : undefined;
      terminal = new Terminated('succeeded', output);
    } catch (err) {
      terminal = err instanceof Terminated ? err : new Terminated('failed', undefined, { code: 'INTERNAL_ERROR', message: String(err) });
    }

    if (state.closed) return;
    run.status = terminal.status;
    run.output = terminal.output ?? null;
    run.error = terminal.error ?? null;
    run.finished_at = nowIso();
    state.emit(run.id, 'status', { status: run.status });
    state.emit(run.id, 'done', { status: run.status, output: run.output, error: run.error });
    if (run.webhook_url && run.webhook_secret) {
      void state.deliverWebhook(run.webhook_url, run.webhook_secret, `workflow_run.${run.status}`, {
        run: publicWorkflowRun(run, false),
      });
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  app.post('/v1/workflows', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = body.name;
    const slug = body.slug;
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'name is required (1-128 chars)');
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'slug must match ^[a-z0-9][a-z0-9_-]{0,62}$');
    }
    if ([...state.workflows.values()].some((w) => w.slug === slug && w.status === 'active')) {
      return sendError(reply, 422, 'VALIDATION_ERROR', `slug '${slug}' is already in use`);
    }
    const issues = validateDefinition(body.definition);
    if (issues.length > 0) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'definition failed validation', { details: issues });
    }
    const wf: WorkflowRec = {
      id: `wf_${hex(4)}`,
      object: 'workflow',
      name,
      slug,
      version: 1,
      dsl_version: '2026-06-01',
      definition: body.definition as Record<string, unknown>,
      inputs_schema: (body.inputs_schema as Record<string, unknown> | null) ?? null,
      description: (body.description as string | null) ?? null,
      status: 'active',
      metadata: (body.metadata as Record<string, unknown> | null) ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.workflows.set(wf.id, wf);
    return reply.status(201).send({ ...wf, request_id: requestId() });
  });

  app.get('/v1/workflows', async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = query.limit !== undefined ? Number(query.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return sendError(reply, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200', { actual: limit, min: 1, max: 200 });
    }
    return {
      object: 'list',
      data: [...state.workflows.values()].slice(0, limit),
      has_more: false,
      request_id: requestId(),
    };
  });

  // ── runs subtree BEFORE dynamic /:id (documented route order) ───────────────
  async function startRun(request: FastifyRequest, reply: FastifyReply, workflow: WorkflowRec | null) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let definition: Record<string, unknown>;
    let version: number | null = null;
    if (workflow) {
      definition = workflow.definition;
      version = workflow.version;
    } else {
      const issues = validateDefinition(body.definition);
      if (body.definition === undefined) {
        return sendError(reply, 422, 'VALIDATION_ERROR', 'Ad-hoc workflow runs require a definition');
      }
      if (issues.length > 0) {
        return sendError(reply, 422, 'VALIDATION_ERROR', 'definition failed validation', { details: issues });
      }
      definition = body.definition as Record<string, unknown>;
    }

    const idemHeader = request.headers['idempotency-key'];
    const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
    const hash = bodyHash(body);
    if (idemKey) {
      const existing = state.idempotency.get(`wfruns:${idemKey}`);
      if (existing) {
        if (existing.bodyHash !== hash) {
          return sendError(reply, 422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was reused with a different body');
        }
        void reply.header('X-Coasty-Idempotent-Replay', 'true');
        return reply.status(existing.status).send(existing.payload);
      }
    }

    const webhookUrl = typeof body.webhook_url === 'string' ? body.webhook_url : null;
    const run: WorkflowRunRec = {
      id: `wfr_${hex(5)}`,
      object: 'workflow.run',
      status: 'queued',
      workflow_id: workflow?.id ?? null,
      workflow_version: version,
      machine_id: (body.machine_id as string | null) ?? null,
      inputs: (body.inputs as Record<string, unknown>) ?? {},
      output: null,
      error: null,
      awaiting_human_reason: null,
      awaiting_step_id: null,
      iterations_used: 0,
      spent_cents: 0,
      budget_cents: (body.budget_cents as number) ?? 0,
      webhook_url: webhookUrl,
      webhook_secret: webhookUrl ? `whsec_${hex(12)}` : null,
      metadata: {
        ...((body.metadata as Record<string, unknown>) ?? {}),
        __max_iterations: (body.max_iterations as number | null) ?? null,
      },
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      request_id: requestId(),
      definitionSnapshot: definition,
      approvalResolve: null,
      cancelled: false,
      deadlineAt: typeof body.deadline_seconds === 'number' ? Date.now() + body.deadline_seconds * 1000 : null,
    };
    state.workflowRuns.set(run.id, run);
    const isTest = request.keyKind === 'test';
    // Kick the interpreter off the request path.
    const timer = state.addTimer(
      setTimeout(() => {
        state.timers.delete(timer);
        void executeRun(run, isTest);
      }, opts.tickMs),
    );

    const payload = publicWorkflowRun(run, true);
    if (idemKey) state.idempotency.set(`wfruns:${idemKey}`, { bodyHash: hash, status: 201, payload });
    return reply.status(201).send(payload);
  }

  app.post('/v1/workflows/runs', async (request, reply) => startRun(request, reply, null));

  app.get('/v1/workflows/runs', async (request) => {
    const query = request.query as { workflow_id?: string; limit?: string };
    const limit = query.limit !== undefined ? Number(query.limit) : 20;
    const data = [...state.workflowRuns.values()]
      .filter((r) => (query.workflow_id ? r.workflow_id === query.workflow_id : true))
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((r) => publicWorkflowRun(r, false));
    return { object: 'list', data, has_more: false, request_id: requestId() };
  });

  app.get('/v1/workflows/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.workflowRuns.get(id);
    if (!run) return sendError(reply, 404, 'NOT_FOUND', `No workflow run '${id}'`);
    return publicWorkflowRun(run, false);
  });

  app.post('/v1/workflows/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.workflowRuns.get(id);
    if (!run) return sendError(reply, 404, 'NOT_FOUND', `No workflow run '${id}'`);
    if (TERMINAL.has(run.status)) {
      return sendError(reply, 409, 'INVALID_STATE', `Cannot cancel a workflow run in state '${run.status}'`, {
        current_state: run.status,
        allowed_from: ['queued', 'running', 'awaiting_human'],
      });
    }
    run.cancelled = true;
    // Unblock a pending approval gate so the interpreter can observe the cancel.
    run.approvalResolve?.({ approved: false, note: 'cancelled' });
    if (run.status === 'queued') {
      run.status = 'cancelled';
      run.finished_at = nowIso();
      state.emit(run.id, 'status', { status: 'cancelled' });
      state.emit(run.id, 'done', { status: 'cancelled' });
    }
    return publicWorkflowRun(run, false);
  });

  app.post('/v1/workflows/runs/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = state.workflowRuns.get(id);
    if (!run) return sendError(reply, 404, 'NOT_FOUND', `No workflow run '${id}'`);
    if (run.status !== 'awaiting_human' || !run.approvalResolve) {
      return sendError(reply, 409, 'NOT_AWAITING_HUMAN', `Workflow run is '${run.status}', not awaiting_human`);
    }
    const body = (request.body ?? {}) as { approved?: unknown; note?: string };
    if (typeof body.approved !== 'boolean') {
      return sendError(reply, 422, 'VALIDATION_ERROR', "resume requires 'approved' (boolean)");
    }
    run.approvalResolve({ approved: body.approved, note: body.note });
    return publicWorkflowRun(run, false);
  });

  app.get('/v1/workflows/runs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    if (!state.workflowRuns.has(id)) {
      void sendError(reply, 404, 'NOT_FOUND', `No workflow run '${id}'`);
      return;
    }
    streamEvents(state, id, request, reply);
  });

  // ── dynamic /:id routes (AFTER the runs subtree) ────────────────────────────
  app.get('/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wf = state.workflows.get(id);
    if (!wf) return sendError(reply, 404, 'WORKFLOW_NOT_FOUND', `No workflow '${id}'`);
    return { ...wf, request_id: requestId() };
  });

  app.put('/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wf = state.workflows.get(id);
    if (!wf) return sendError(reply, 404, 'WORKFLOW_NOT_FOUND', `No workflow '${id}'`);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.definition !== undefined) {
      const issues = validateDefinition(body.definition);
      if (issues.length > 0) {
        return sendError(reply, 422, 'VALIDATION_ERROR', 'definition failed validation', { details: issues });
      }
      wf.definition = body.definition as Record<string, unknown>;
    }
    if (typeof body.name === 'string') wf.name = body.name;
    if (typeof body.description === 'string' || body.description === null) wf.description = body.description as string | null;
    if (body.status === 'active' || body.status === 'archived') wf.status = body.status;
    wf.version++;
    wf.updated_at = nowIso();
    return { ...wf, request_id: requestId() };
  });

  app.delete('/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wf = state.workflows.get(id);
    if (!wf) return sendError(reply, 404, 'WORKFLOW_NOT_FOUND', `No workflow '${id}'`);
    wf.status = 'archived';
    wf.updated_at = nowIso();
    return { ...wf, request_id: requestId() };
  });

  app.post('/v1/workflows/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wf = state.workflows.get(id);
    if (!wf) return sendError(reply, 404, 'WORKFLOW_NOT_FOUND', `No workflow '${id}'`);
    return startRun(request, reply, wf);
  });
}
