/**
 * Structured-condition evaluation: the 13 documented ops, injection-safe
 * (no free-text eval). Operands are template-resolved against the scope first.
 */
import type { Condition } from '../types';
import { resolveTemplate, type TemplateScope } from './template';

/** Coerce to a finite number, accepting numeric strings; undefined otherwise. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/** Strict-ish equality: same-type primitives compare with ===; objects by JSON. */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Evaluate a structured condition against a scope.
 * Unknown ops throw (validation should have rejected them earlier).
 */
export function evaluateCondition(cond: Condition, scope: TemplateScope): boolean {
  switch (cond.op) {
    case 'eq':
      return isEqual(resolveTemplate(cond.left, scope), resolveTemplate(cond.right, scope));
    case 'ne':
      return !isEqual(resolveTemplate(cond.left, scope), resolveTemplate(cond.right, scope));
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const l = asNumber(resolveTemplate(cond.left, scope));
      const r = asNumber(resolveTemplate(cond.right, scope));
      if (l === undefined || r === undefined) return false;
      switch (cond.op) {
        case 'lt':
          return l < r;
        case 'gt':
          return l > r;
        case 'lte':
          return l <= r;
        case 'gte':
          return l >= r;
      }
      break;
    }
    case 'contains': {
      const l = resolveTemplate(cond.left, scope);
      const r = resolveTemplate(cond.right, scope);
      if (typeof l === 'string') return l.includes(String(r));
      if (Array.isArray(l)) return l.some((item) => isEqual(item, r));
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
      return cond.conditions.every((c) => evaluateCondition(c, scope));
    case 'or':
      return cond.conditions.some((c) => evaluateCondition(c, scope));
    case 'not':
      return !evaluateCondition(cond.condition, scope);
    default: {
      const unknown = cond as { op: string };
      throw new Error(`Unknown condition op: ${unknown.op}`);
    }
  }
  // Unreachable; satisfies control-flow analysis.
  return false;
}
