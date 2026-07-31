/**
 * Server-side `action_policy` validation for the mock.
 *
 * Deliberately hand-written and NOT shared with `@open-cowork/core` (see
 * DECISIONS.md D9): if the mock imported core's validator, a bug in core's
 * understanding of the contract would be invisible because both sides of the
 * test would agree. Two independent implementations of the same documented
 * rules is the point.
 */

export interface PolicyError {
  message: string;
  extras: Record<string, unknown>;
}

const KNOWN_FIELDS = new Set([
  'allowed_actions',
  'blocked_actions',
  'blocked_keys',
  'block_window_close',
  'max_actions',
  'coordinate_bounds',
]);

const BOUND_FIELDS = ['min_x', 'min_y', 'max_x', 'max_y'] as const;

function fail(message: string, loc: string[]): PolicyError {
  return { message, extras: { details: [{ loc: ['body', ...loc], type: 'value_error' }] } };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Validate a submitted `action_policy`. Returns null when acceptable (including
 * when absent — omission preserves unrestricted compatibility behavior).
 */
export function validateActionPolicyBody(policy: unknown): PolicyError | null {
  if (policy === undefined || policy === null) return null;
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    return fail('action_policy must be an object', ['action_policy']);
  }
  const p = policy as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!KNOWN_FIELDS.has(key)) {
      return fail(`Unknown action_policy field '${key}'`, ['action_policy', key]);
    }
  }

  if (p.allowed_actions !== undefined) {
    if (!isStringArray(p.allowed_actions)) {
      return fail('allowed_actions must be an array of action names', [
        'action_policy',
        'allowed_actions',
      ]);
    }
    if (p.allowed_actions.length < 1 || p.allowed_actions.length > 128) {
      return fail('allowed_actions accepts 1-128 action names', [
        'action_policy',
        'allowed_actions',
      ]);
    }
  }

  if (p.blocked_actions !== undefined) {
    if (!isStringArray(p.blocked_actions)) {
      return fail('blocked_actions must be an array of action names', [
        'action_policy',
        'blocked_actions',
      ]);
    }
    if (p.blocked_actions.length > 128) {
      return fail('blocked_actions accepts at most 128 action names', [
        'action_policy',
        'blocked_actions',
      ]);
    }
  }

  // Documented: the two lists cannot overlap.
  if (isStringArray(p.allowed_actions) && isStringArray(p.blocked_actions)) {
    const allowed = new Set(p.allowed_actions);
    const clash = p.blocked_actions.find((name) => allowed.has(name));
    if (clash !== undefined) {
      return fail(`'${clash}' cannot appear in both allowed_actions and blocked_actions`, [
        'action_policy',
        'blocked_actions',
      ]);
    }
  }

  if (p.blocked_keys !== undefined) {
    if (!isStringArray(p.blocked_keys)) {
      return fail('blocked_keys must be an array of key names', ['action_policy', 'blocked_keys']);
    }
    if (p.blocked_keys.length > 128) {
      return fail('blocked_keys accepts at most 128 key names', ['action_policy', 'blocked_keys']);
    }
  }

  if (p.block_window_close !== undefined && typeof p.block_window_close !== 'boolean') {
    return fail('block_window_close must be a boolean', ['action_policy', 'block_window_close']);
  }

  if (p.max_actions !== undefined) {
    const max = p.max_actions;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 10000) {
      return fail('max_actions must be an integer between 1 and 10000', [
        'action_policy',
        'max_actions',
      ]);
    }
  }

  if (p.coordinate_bounds !== undefined) {
    const bounds = p.coordinate_bounds;
    if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
      return fail('coordinate_bounds must be an object', ['action_policy', 'coordinate_bounds']);
    }
    const b = bounds as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (!(BOUND_FIELDS as readonly string[]).includes(key)) {
        return fail(`Unknown coordinate_bounds field '${key}'`, [
          'action_policy',
          'coordinate_bounds',
          key,
        ]);
      }
    }
    for (const field of BOUND_FIELDS) {
      const v = b[field];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return fail(`coordinate_bounds.${field} is required and must be a finite number`, [
          'action_policy',
          'coordinate_bounds',
          field,
        ]);
      }
    }
    // The rectangle is INCLUSIVE, so min == max is a legal one-pixel bound.
    if ((b.min_x as number) > (b.max_x as number)) {
      return fail('coordinate_bounds.min_x must be <= max_x', [
        'action_policy',
        'coordinate_bounds',
      ]);
    }
    if ((b.min_y as number) > (b.max_y as number)) {
      return fail('coordinate_bounds.min_y must be <= max_y', [
        'action_policy',
        'coordinate_bounds',
      ]);
    }
  }

  return null;
}
