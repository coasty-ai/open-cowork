/**
 * Client-side validation for {@link ActionPolicy}, mirroring every documented
 * limit so a bad policy is caught before a billable round-trip — the same
 * instant-feedback role `validateWorkflowDefinition` plays for the DSL.
 *
 * This is a SHAPE validator, not an enforcement engine. Coasty enforces the
 * policy server-side after inference and before dispatch; this exists so the
 * builder UI and the backend can reject an unusable policy up front, and so the
 * exact submitted policy can be normalized for the client audit log (responses
 * never echo the normalized policy back).
 */
import type { ActionPolicy } from './types';

export interface ActionPolicyIssue {
  path: string;
  message: string;
}

export interface ActionPolicyValidationResult {
  valid: boolean;
  issues: ActionPolicyIssue[];
}

/** Documented limits. Exported so tests and UIs quote one source. */
export const ACTION_POLICY_LIMITS = {
  maxAllowedActions: 128,
  minAllowedActions: 1,
  maxBlockedActions: 128,
  maxBlockedKeys: 128,
  minMaxActions: 1,
  maxMaxActions: 10_000,
} as const;

/**
 * Terminal control signals remain available regardless of `allowed_actions`.
 * Listing one is not an error, but it is meaningless — we surface that as an
 * issue only when it is the ONLY thing allowed (which would allow no work).
 */
const TERMINAL_SIGNALS = new Set(['done', 'fail', 'awaiting_human']);

/** `esc` aliases `escape`; comparison is case-insensitive. */
export function normalizeBlockedKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return lower === 'esc' ? 'escape' : lower;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNameList(
  value: unknown,
  path: string,
  max: number,
  issues: ActionPolicyIssue[],
  min = 0,
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array of action names` });
    return null;
  }
  if (value.length < min) {
    issues.push({ path, message: `${path} must contain at least ${min} action name(s)` });
  }
  if (value.length > max) {
    issues.push({
      path,
      message: `${path} accepts at most ${max} action names (got ${value.length})`,
    });
  }
  const names: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push({ path: `${path}[${i}]`, message: 'action names must be non-empty strings' });
      return;
    }
    names.push(entry.trim());
  });
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      issues.push({ path, message: `duplicate action name '${name}'` });
    }
    seen.add(name);
  }
  return names;
}

/**
 * Validate a policy's shape against the documented contract.
 * An `undefined`/`null` policy is valid — omission preserves the unrestricted
 * compatibility behavior.
 */
export function validateActionPolicy(policy: unknown): ActionPolicyValidationResult {
  const issues: ActionPolicyIssue[] = [];
  if (policy === undefined || policy === null) return { valid: true, issues };
  if (!isPlainObject(policy)) {
    return {
      valid: false,
      issues: [{ path: 'action_policy', message: 'action_policy must be an object' }],
    };
  }

  const known = new Set([
    'allowed_actions',
    'blocked_actions',
    'blocked_keys',
    'block_window_close',
    'max_actions',
    'coordinate_bounds',
  ]);
  for (const key of Object.keys(policy)) {
    if (!known.has(key)) {
      issues.push({ path: `action_policy.${key}`, message: `unknown field '${key}'` });
    }
  }

  let allowed: string[] | null = null;
  if (policy.allowed_actions !== undefined) {
    allowed = checkNameList(
      policy.allowed_actions,
      'action_policy.allowed_actions',
      ACTION_POLICY_LIMITS.maxAllowedActions,
      issues,
      ACTION_POLICY_LIMITS.minAllowedActions,
    );
    if (allowed && allowed.length > 0 && allowed.every((a) => TERMINAL_SIGNALS.has(a))) {
      issues.push({
        path: 'action_policy.allowed_actions',
        message:
          'allowing only terminal signals permits no work; terminal signals are always available and need not be listed',
      });
    }
  }

  let blocked: string[] | null = null;
  if (policy.blocked_actions !== undefined) {
    blocked = checkNameList(
      policy.blocked_actions,
      'action_policy.blocked_actions',
      ACTION_POLICY_LIMITS.maxBlockedActions,
      issues,
    );
  }

  // Documented: blocked_actions cannot overlap allowed_actions.
  if (allowed && blocked) {
    const allowSet = new Set(allowed);
    for (const name of blocked) {
      if (allowSet.has(name)) {
        issues.push({
          path: 'action_policy.blocked_actions',
          message: `'${name}' cannot appear in both allowed_actions and blocked_actions`,
        });
      }
    }
  }

  if (policy.blocked_keys !== undefined) {
    const keys = checkNameList(
      policy.blocked_keys,
      'action_policy.blocked_keys',
      ACTION_POLICY_LIMITS.maxBlockedKeys,
      issues,
    );
    // `esc` and `escape` collapse to one key — flag the redundancy rather than
    // silently deduplicating something the caller may have meant differently.
    if (keys) {
      const seen = new Map<string, string>();
      for (const key of keys) {
        const canonical = normalizeBlockedKey(key);
        const prior = seen.get(canonical);
        if (prior !== undefined && prior !== key) {
          issues.push({
            path: 'action_policy.blocked_keys',
            message: `'${key}' and '${prior}' both normalize to '${canonical}'`,
          });
        }
        seen.set(canonical, key);
      }
    }
  }

  if (policy.block_window_close !== undefined && typeof policy.block_window_close !== 'boolean') {
    issues.push({
      path: 'action_policy.block_window_close',
      message: 'block_window_close must be a boolean',
    });
  }

  if (policy.max_actions !== undefined) {
    const max = policy.max_actions;
    if (typeof max !== 'number' || !Number.isInteger(max)) {
      issues.push({ path: 'action_policy.max_actions', message: 'max_actions must be an integer' });
    } else if (
      max < ACTION_POLICY_LIMITS.minMaxActions ||
      max > ACTION_POLICY_LIMITS.maxMaxActions
    ) {
      issues.push({
        path: 'action_policy.max_actions',
        message: `max_actions must be between ${ACTION_POLICY_LIMITS.minMaxActions} and ${ACTION_POLICY_LIMITS.maxMaxActions}`,
      });
    }
  }

  if (policy.coordinate_bounds !== undefined) {
    const bounds = policy.coordinate_bounds;
    if (!isPlainObject(bounds)) {
      issues.push({
        path: 'action_policy.coordinate_bounds',
        message: 'coordinate_bounds must be an object',
      });
    } else {
      const required = ['min_x', 'min_y', 'max_x', 'max_y'] as const;
      const values: Partial<Record<(typeof required)[number], number>> = {};
      for (const field of required) {
        const v = bounds[field];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          issues.push({
            path: `action_policy.coordinate_bounds.${field}`,
            message: `${field} is required and must be a finite number`,
          });
        } else {
          values[field] = v;
        }
      }
      for (const key of Object.keys(bounds)) {
        if (!(required as readonly string[]).includes(key)) {
          issues.push({
            path: `action_policy.coordinate_bounds.${key}`,
            message: `unknown field '${key}'`,
          });
        }
      }
      // The rectangle is INCLUSIVE, so min == max is a legal 1px bound.
      if (values.min_x !== undefined && values.max_x !== undefined && values.min_x > values.max_x) {
        issues.push({
          path: 'action_policy.coordinate_bounds',
          message: `min_x (${values.min_x}) must be <= max_x (${values.max_x})`,
        });
      }
      if (values.min_y !== undefined && values.max_y !== undefined && values.min_y > values.max_y) {
        issues.push({
          path: 'action_policy.coordinate_bounds',
          message: `min_y (${values.min_y}) must be <= max_y (${values.max_y})`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Canonical form for an audit log / equality check. Responses never echo the
 * normalized policy, so a caller that wants to prove what it submitted has to
 * keep this itself. Key order is stabilized so the result can be hashed.
 */
export function canonicalizeActionPolicy(policy: ActionPolicy): ActionPolicy {
  const out: ActionPolicy = {};
  if (policy.allowed_actions) out.allowed_actions = [...policy.allowed_actions].sort();
  if (policy.blocked_actions) out.blocked_actions = [...policy.blocked_actions].sort();
  if (policy.blocked_keys) {
    out.blocked_keys = [...new Set(policy.blocked_keys.map(normalizeBlockedKey))].sort();
  }
  if (policy.block_window_close !== undefined) out.block_window_close = policy.block_window_close;
  if (policy.max_actions !== undefined) out.max_actions = policy.max_actions;
  if (policy.coordinate_bounds) {
    const b = policy.coordinate_bounds;
    out.coordinate_bounds = { min_x: b.min_x, min_y: b.min_y, max_x: b.max_x, max_y: b.max_y };
  }
  return out;
}
