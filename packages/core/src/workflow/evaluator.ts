/**
 * Client-side workflow evaluator mirroring the documented server semantics.
 * Used for: builder dry-runs, offline validation of behavior, cost estimation,
 * and (independently re-implemented) by the mock server.
 *
 * Deterministic: task execution, approvals, and the clock are injected.
 */
import type {
  TaskStep,
  TaskStepResult,
  WorkflowDefinition,
  WorkflowStep,
  HumanApprovalStep,
} from '../types';
import { evaluateCondition } from './conditions';
import { resolveDeep, resolveTemplate, type TemplateScope } from './template';
import { validateWorkflowDefinition } from './validate';

export interface WorkflowGuards {
  /** Total spend cap across all task steps, cents. 0/undefined = uncapped. */
  budgetCents?: number;
  /** Cap on total loop iterations consumed. */
  maxIterations?: number;
  /** Wall-clock budget in seconds (measured with the injected clock). */
  deadlineSeconds?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
}

export type WorkflowEvalEvent =
  | { type: 'step-start'; stepId: string; stepType: WorkflowStep['type'] }
  | {
      type: 'step-finish';
      stepId: string;
      stepType: WorkflowStep['type'];
      outcome: 'ok' | 'failed';
    }
  | { type: 'task-result'; stepId: string; result: TaskStepResult }
  | { type: 'awaiting-approval'; stepId: string; message?: string }
  | { type: 'approval-decision'; stepId: string; approved: boolean }
  | { type: 'guard-exceeded'; guard: 'budget_cents' | 'max_iterations' | 'deadline_seconds' };

export interface ExecuteWorkflowOptions {
  definition: WorkflowDefinition;
  inputs?: Record<string, unknown>;
  guards?: WorkflowGuards;
  /** Executes one task step; the evaluator passes the template-resolved task text. */
  runTask: (step: TaskStep, resolvedTask: string) => Promise<TaskStepResult>;
  /** Decides a human_approval step. Absent → auto-reject (fail closed). */
  onApproval?: (step: HumanApprovalStep, message: string | undefined) => Promise<ApprovalDecision>;
  onEvent?: (event: WorkflowEvalEvent) => void;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
}

export interface WorkflowEvalResult {
  status: 'succeeded' | 'failed';
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  spentCents: number;
  iterationsUsed: number;
  /** Every bound task result, keyed by save_as and step id. */
  bindings: Record<string, unknown>;
}

/** Internal control-flow signals. */
class WorkflowTermination {
  constructor(
    readonly status: 'succeeded' | 'failed',
    readonly output?: Record<string, unknown>,
    readonly error?: { code: string; message: string },
  ) {}
}
class StepFailure extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(message);
  }
}

export async function executeWorkflow(opts: ExecuteWorkflowOptions): Promise<WorkflowEvalResult> {
  const { definition, runTask, onApproval, onEvent, guards = {} } = opts;
  const now = opts.now ?? Date.now;

  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    const first = validation.issues[0]!;
    return {
      status: 'failed',
      error: { code: 'VALIDATION_ERROR', message: `${first.path}: ${first.message}` },
      spentCents: 0,
      iterationsUsed: 0,
      bindings: {},
    };
  }

  const scope: TemplateScope = {
    inputs: opts.inputs ?? {},
    vars: {},
  };
  const state = {
    spentCents: 0,
    iterationsUsed: 0,
    startedAt: now(),
  };

  const checkGuards = (): void => {
    if (
      guards.budgetCents !== undefined &&
      guards.budgetCents > 0 &&
      state.spentCents > guards.budgetCents
    ) {
      onEvent?.({ type: 'guard-exceeded', guard: 'budget_cents' });
      throw new WorkflowTermination('failed', undefined, {
        code: 'GUARD_EXCEEDED',
        message: `budget_cents exceeded: spent ${state.spentCents} > cap ${guards.budgetCents}`,
      });
    }
    if (guards.maxIterations !== undefined && state.iterationsUsed > guards.maxIterations) {
      onEvent?.({ type: 'guard-exceeded', guard: 'max_iterations' });
      throw new WorkflowTermination('failed', undefined, {
        code: 'GUARD_EXCEEDED',
        message: `max_iterations exceeded: ${state.iterationsUsed} > cap ${guards.maxIterations}`,
      });
    }
    if (
      guards.deadlineSeconds !== undefined &&
      now() - state.startedAt > guards.deadlineSeconds * 1000
    ) {
      onEvent?.({ type: 'guard-exceeded', guard: 'deadline_seconds' });
      throw new WorkflowTermination('failed', undefined, {
        code: 'GUARD_EXCEEDED',
        message: `deadline_seconds (${guards.deadlineSeconds}s) exceeded`,
      });
    }
  };

  async function executeSteps(steps: WorkflowStep[]): Promise<void> {
    for (const step of steps) {
      checkGuards();
      onEvent?.({ type: 'step-start', stepId: step.id, stepType: step.type });
      await executeStep(step);
      onEvent?.({ type: 'step-finish', stepId: step.id, stepType: step.type, outcome: 'ok' });
    }
  }

  async function executeStep(step: WorkflowStep): Promise<void> {
    switch (step.type) {
      case 'task': {
        const resolvedTask = String(resolveTemplate(step.task, scope));
        const result = await runTask(step, resolvedTask);
        state.spentCents += result.costCents ?? 0;
        const binding: TaskStepResult = { ...result };
        scope[step.id] = binding;
        if (step.save_as) scope[step.save_as] = binding;
        onEvent?.({ type: 'task-result', stepId: step.id, result: binding });
        checkGuards();
        // Per docs, a task that fails does not by itself end the workflow —
        // asserts/conditions decide. But a transport-level error does.
        if (result.error && result.status === 'failed' && result.run_id === '') {
          throw new StepFailure(step.id, result.error.message);
        }
        return;
      }
      case 'assert': {
        if (!evaluateCondition(step.condition, scope)) {
          throw new WorkflowTermination('failed', undefined, {
            code: 'ASSERTION_FAILED',
            message: step.message ?? `Assertion '${step.id}' failed`,
          });
        }
        return;
      }
      case 'if': {
        if (evaluateCondition(step.condition, scope)) {
          await executeSteps(step.then);
        } else if (step.else) {
          await executeSteps(step.else);
        }
        return;
      }
      case 'loop': {
        const stepCap = step.max_iterations;
        let localIterations = 0;
        if (step.count !== undefined) {
          for (let i = 0; i < step.count; i++) {
            localIterations++;
            state.iterationsUsed++;
            checkGuards();
            if (stepCap !== undefined && localIterations > stepCap) return;
            await executeSteps(step.body);
          }
        } else if (step.while !== undefined) {
          while (evaluateCondition(step.while, scope)) {
            localIterations++;
            state.iterationsUsed++;
            checkGuards();
            if (stepCap !== undefined && localIterations > stepCap) return;
            await executeSteps(step.body);
          }
        }
        return;
      }
      case 'parallel': {
        // Branches run concurrently and share the scope (last write wins on
        // conflicting save_as names — mirroring documented server behavior of
        // binding every branch's results).
        await Promise.all(step.branches.map((branch) => executeSteps(branch)));
        return;
      }
      case 'retry': {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= step.max_attempts; attempt++) {
          try {
            scope.vars = { ...(scope.vars as Record<string, unknown>), attempt };
            await executeSteps(step.body);
            return;
          } catch (err) {
            if (err instanceof WorkflowTermination && err.status === 'succeeded') throw err;
            lastErr = err;
          }
        }
        if (lastErr instanceof WorkflowTermination) throw lastErr;
        throw new WorkflowTermination('failed', undefined, {
          code: 'RETRY_EXHAUSTED',
          message: `retry '${step.id}' failed after ${step.max_attempts} attempts`,
        });
      }
      case 'human_approval': {
        const message =
          step.message !== undefined ? String(resolveTemplate(step.message, scope)) : undefined;
        onEvent?.({ type: 'awaiting-approval', stepId: step.id, message });
        const decision = onApproval
          ? await onApproval(step, message)
          : { approved: false, note: 'No approval handler configured' };
        onEvent?.({ type: 'approval-decision', stepId: step.id, approved: decision.approved });
        if (!decision.approved) {
          throw new WorkflowTermination('failed', undefined, {
            code: 'APPROVAL_REJECTED',
            message: decision.note ?? `Approval '${step.id}' was rejected`,
          });
        }
        return;
      }
      case 'succeed': {
        const output = step.output
          ? (resolveDeep(step.output, scope) as Record<string, unknown>)
          : undefined;
        throw new WorkflowTermination('succeeded', output);
      }
      case 'fail': {
        const message =
          step.message !== undefined
            ? String(resolveTemplate(step.message, scope))
            : 'Workflow failed';
        throw new WorkflowTermination('failed', undefined, { code: 'WORKFLOW_FAILED', message });
      }
    }
  }

  const collectBindings = (): Record<string, unknown> => {
    const { inputs: _inputs, vars: _vars, ...bindings } = scope;
    return bindings;
  };

  try {
    await executeSteps(definition.steps);
    // Ran off the end without an explicit succeed/fail: implicit success.
    const output = definition.output
      ? (resolveDeep(definition.output, scope) as Record<string, unknown>)
      : undefined;
    return {
      status: 'succeeded',
      output,
      spentCents: state.spentCents,
      iterationsUsed: state.iterationsUsed,
      bindings: collectBindings(),
    };
  } catch (err) {
    if (err instanceof WorkflowTermination) {
      const output =
        err.status === 'succeeded'
          ? (err.output ??
            (definition.output
              ? (resolveDeep(definition.output, scope) as Record<string, unknown>)
              : undefined))
          : err.output;
      return {
        status: err.status,
        output,
        error: err.error,
        spentCents: state.spentCents,
        iterationsUsed: state.iterationsUsed,
        bindings: collectBindings(),
      };
    }
    if (err instanceof StepFailure) {
      return {
        status: 'failed',
        error: { code: 'STEP_FAILED', message: `Step '${err.stepId}': ${err.message}` },
        spentCents: state.spentCents,
        iterationsUsed: state.iterationsUsed,
        bindings: collectBindings(),
      };
    }
    throw err;
  }
}
