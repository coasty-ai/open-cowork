/**
 * Structural validation of a workflow definition, mirroring every documented
 * server-side limit so builders get instant feedback and the backend can reject
 * bad definitions before they reach Coasty.
 *
 * Documented limits (llms.txt §5):
 * - step ids match ^[A-Za-z0-9_-]{1,64}$ and are unique across the whole tree
 * - ≤200 steps total (counting every nested step), nesting ≤8 levels deep
 * - parallel: ≤16 branches; no human_approval/succeed/fail anywhere inside
 * - retry.max_attempts: integer 1..20
 * - loop: exactly one of count | while
 * - save_as must not be 'inputs' or 'vars'
 * - DSL version 2026-06-01: 9 step types, 13 condition ops
 */
import type { Condition, WorkflowDefinition, WorkflowStep } from '../types';

export const DSL_VERSION = '2026-06-01';
export const MAX_TOTAL_STEPS = 200;
export const MAX_NESTING_DEPTH = 8;
export const MAX_PARALLEL_BRANCHES = 16;
export const RETRY_ATTEMPTS_MIN = 1;
export const RETRY_ATTEMPTS_MAX = 20;
export const RESERVED_SAVE_AS = ['inputs', 'vars'] as const;

const STEP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STEP_TYPES = new Set([
  'task',
  'assert',
  'if',
  'loop',
  'parallel',
  'human_approval',
  'retry',
  'succeed',
  'fail',
]);
const CONDITION_OPS = new Set([
  'eq',
  'ne',
  'lt',
  'gt',
  'lte',
  'gte',
  'contains',
  'truthy',
  'falsy',
  'exists',
  'and',
  'or',
  'not',
]);
const BINARY_OPS = new Set(['eq', 'ne', 'lt', 'gt', 'lte', 'gte', 'contains']);
const UNARY_VALUE_OPS = new Set(['truthy', 'falsy', 'exists']);

export interface ValidationIssue {
  /** JSON-path-ish location, e.g. `steps[2].then[0].max_attempts`. */
  path: string;
  code:
    | 'MISSING_STEPS'
    | 'INVALID_STEP'
    | 'INVALID_ID'
    | 'DUPLICATE_ID'
    | 'UNKNOWN_TYPE'
    | 'MISSING_FIELD'
    | 'INVALID_FIELD'
    | 'TOO_MANY_STEPS'
    | 'TOO_DEEP'
    | 'TOO_MANY_BRANCHES'
    | 'INVALID_RETRY'
    | 'INVALID_LOOP'
    | 'FORBIDDEN_IN_PARALLEL'
    | 'RESERVED_SAVE_AS'
    | 'INVALID_CONDITION';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function validateCondition(cond: unknown, path: string, issues: ValidationIssue[]): void {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
    issues.push({ path, code: 'INVALID_CONDITION', message: 'Condition must be an object' });
    return;
  }
  const c = cond as Partial<Condition> & { op?: unknown; conditions?: unknown; condition?: unknown };
  if (typeof c.op !== 'string' || !CONDITION_OPS.has(c.op)) {
    issues.push({
      path: `${path}.op`,
      code: 'INVALID_CONDITION',
      message: `Unknown condition op '${String(c.op)}' (expected one of ${[...CONDITION_OPS].join(', ')})`,
    });
    return;
  }
  if (BINARY_OPS.has(c.op)) {
    if (!('left' in c) || !('right' in c)) {
      issues.push({ path, code: 'INVALID_CONDITION', message: `'${c.op}' requires left and right` });
    }
  } else if (UNARY_VALUE_OPS.has(c.op)) {
    if (!('value' in c)) {
      issues.push({ path, code: 'INVALID_CONDITION', message: `'${c.op}' requires value` });
    }
  } else if (c.op === 'and' || c.op === 'or') {
    if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
      issues.push({
        path: `${path}.conditions`,
        code: 'INVALID_CONDITION',
        message: `'${c.op}' requires a non-empty conditions array`,
      });
    } else {
      c.conditions.forEach((sub, i) => validateCondition(sub, `${path}.conditions[${i}]`, issues));
    }
  } else if (c.op === 'not') {
    if (c.condition === undefined) {
      issues.push({ path, code: 'INVALID_CONDITION', message: `'not' requires condition` });
    } else {
      validateCondition(c.condition, `${path}.condition`, issues);
    }
  }
}

interface WalkContext {
  issues: ValidationIssue[];
  seenIds: Map<string, string>;
  totalSteps: number;
  insideParallel: boolean;
}

function walkSteps(steps: unknown, path: string, depth: number, ctx: WalkContext): void {
  if (!Array.isArray(steps)) {
    ctx.issues.push({ path, code: 'INVALID_STEP', message: 'Expected an array of steps' });
    return;
  }
  if (depth > MAX_NESTING_DEPTH) {
    ctx.issues.push({
      path,
      code: 'TOO_DEEP',
      message: `Steps nest at most ${MAX_NESTING_DEPTH} levels deep`,
    });
    return;
  }
  steps.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    ctx.totalSteps++;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.issues.push({ path: p, code: 'INVALID_STEP', message: 'Step must be an object' });
      return;
    }
    const step = raw as Partial<WorkflowStep> & Record<string, unknown>;
    if (typeof step.id !== 'string' || !STEP_ID_RE.test(step.id)) {
      ctx.issues.push({
        path: `${p}.id`,
        code: 'INVALID_ID',
        message: `Step id must match ^[A-Za-z0-9_-]{1,64}$ (got '${String(step.id)}')`,
      });
    } else if (ctx.seenIds.has(step.id)) {
      ctx.issues.push({
        path: `${p}.id`,
        code: 'DUPLICATE_ID',
        message: `Duplicate step id '${step.id}' (first used at ${ctx.seenIds.get(step.id)})`,
      });
    } else {
      ctx.seenIds.set(step.id, p);
    }
    if (typeof step.type !== 'string' || !STEP_TYPES.has(step.type)) {
      ctx.issues.push({
        path: `${p}.type`,
        code: 'UNKNOWN_TYPE',
        message: `Unknown step type '${String(step.type)}'`,
      });
      return;
    }

    if (ctx.insideParallel && (step.type === 'human_approval' || step.type === 'succeed' || step.type === 'fail')) {
      ctx.issues.push({
        path: p,
        code: 'FORBIDDEN_IN_PARALLEL',
        message: `'${step.type}' is not allowed inside a parallel branch`,
      });
    }

    switch (step.type) {
      case 'task': {
        if (typeof step.task !== 'string' || step.task.length === 0) {
          ctx.issues.push({ path: `${p}.task`, code: 'MISSING_FIELD', message: `'task' requires a non-empty task string` });
        }
        if (step.save_as !== undefined) {
          if (typeof step.save_as !== 'string' || !STEP_ID_RE.test(step.save_as)) {
            ctx.issues.push({ path: `${p}.save_as`, code: 'INVALID_FIELD', message: 'save_as must be a short identifier' });
          } else if ((RESERVED_SAVE_AS as readonly string[]).includes(step.save_as)) {
            ctx.issues.push({
              path: `${p}.save_as`,
              code: 'RESERVED_SAVE_AS',
              message: `save_as must not be '${step.save_as}' (reserved namespace)`,
            });
          }
        }
        break;
      }
      case 'assert': {
        if (step.condition === undefined) {
          ctx.issues.push({ path: `${p}.condition`, code: 'MISSING_FIELD', message: `'assert' requires a condition` });
        } else {
          validateCondition(step.condition, `${p}.condition`, ctx.issues);
        }
        break;
      }
      case 'if': {
        if (step.condition === undefined) {
          ctx.issues.push({ path: `${p}.condition`, code: 'MISSING_FIELD', message: `'if' requires a condition` });
        } else {
          validateCondition(step.condition, `${p}.condition`, ctx.issues);
        }
        if (step.then === undefined) {
          ctx.issues.push({ path: `${p}.then`, code: 'MISSING_FIELD', message: `'if' requires a then branch` });
        } else {
          walkSteps(step.then, `${p}.then`, depth + 1, ctx);
        }
        if (step.else !== undefined) walkSteps(step.else, `${p}.else`, depth + 1, ctx);
        break;
      }
      case 'loop': {
        const hasCount = step.count !== undefined;
        const hasWhile = step.while !== undefined;
        if (hasCount === hasWhile) {
          ctx.issues.push({
            path: p,
            code: 'INVALID_LOOP',
            message: `'loop' requires exactly one of count | while`,
          });
        }
        if (hasCount && (typeof step.count !== 'number' || !Number.isInteger(step.count) || step.count < 0)) {
          ctx.issues.push({ path: `${p}.count`, code: 'INVALID_FIELD', message: 'count must be a non-negative integer' });
        }
        if (hasWhile) validateCondition(step.while, `${p}.while`, ctx.issues);
        if (step.body === undefined) {
          ctx.issues.push({ path: `${p}.body`, code: 'MISSING_FIELD', message: `'loop' requires a body` });
        } else {
          walkSteps(step.body, `${p}.body`, depth + 1, ctx);
        }
        break;
      }
      case 'parallel': {
        if (!Array.isArray(step.branches) || step.branches.length === 0) {
          ctx.issues.push({ path: `${p}.branches`, code: 'MISSING_FIELD', message: `'parallel' requires branches` });
          break;
        }
        if (step.branches.length > MAX_PARALLEL_BRANCHES) {
          ctx.issues.push({
            path: `${p}.branches`,
            code: 'TOO_MANY_BRANCHES',
            message: `parallel takes at most ${MAX_PARALLEL_BRANCHES} branches (got ${step.branches.length})`,
          });
        }
        const inner = { ...ctx, insideParallel: true };
        step.branches.forEach((branch, b) => {
          walkSteps(branch, `${p}.branches[${b}]`, depth + 1, inner);
        });
        // propagate counters mutated through the shared maps/numbers
        ctx.totalSteps = inner.totalSteps;
        break;
      }
      case 'retry': {
        if (
          typeof step.max_attempts !== 'number' ||
          !Number.isInteger(step.max_attempts) ||
          step.max_attempts < RETRY_ATTEMPTS_MIN ||
          step.max_attempts > RETRY_ATTEMPTS_MAX
        ) {
          ctx.issues.push({
            path: `${p}.max_attempts`,
            code: 'INVALID_RETRY',
            message: `retry.max_attempts must be an integer ${RETRY_ATTEMPTS_MIN}..${RETRY_ATTEMPTS_MAX}`,
          });
        }
        if (step.body === undefined) {
          ctx.issues.push({ path: `${p}.body`, code: 'MISSING_FIELD', message: `'retry' requires a body` });
        } else {
          walkSteps(step.body, `${p}.body`, depth + 1, ctx);
        }
        break;
      }
      case 'human_approval':
      case 'succeed':
      case 'fail':
        break;
    }
  });
}

/** Validate a workflow definition. Returns every issue found (does not stop at the first). */
export function validateWorkflowDefinition(definition: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return { valid: false, issues: [{ path: '', code: 'MISSING_STEPS', message: 'Definition must be an object' }] };
  }
  const def = definition as Partial<WorkflowDefinition>;
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    issues.push({ path: 'steps', code: 'MISSING_STEPS', message: 'Definition requires a non-empty steps array' });
    return { valid: false, issues };
  }
  const ctx: WalkContext = { issues, seenIds: new Map(), totalSteps: 0, insideParallel: false };
  walkSteps(def.steps, 'steps', 1, ctx);
  if (ctx.totalSteps > MAX_TOTAL_STEPS) {
    issues.push({
      path: 'steps',
      code: 'TOO_MANY_STEPS',
      message: `At most ${MAX_TOTAL_STEPS} steps total (got ${ctx.totalSteps})`,
    });
  }
  return { valid: issues.length === 0, issues };
}
