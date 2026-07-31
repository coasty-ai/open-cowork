import { describe, expect, it } from 'vitest';
import {
  ACTION_POLICY_LIMITS,
  canonicalizeActionPolicy,
  normalizeBlockedKey,
  validateActionPolicy,
  type ActionPolicy,
} from '../src/index';

const ok = (policy: unknown) => validateActionPolicy(policy);
const paths = (policy: unknown) => validateActionPolicy(policy).issues.map((i) => i.path);

describe('validateActionPolicy — absence and shape', () => {
  it('treats undefined and null as valid (omission = unrestricted compatibility)', () => {
    expect(ok(undefined).valid).toBe(true);
    expect(ok(null).valid).toBe(true);
    expect(ok({}).valid).toBe(true);
  });

  it('rejects non-objects, including arrays', () => {
    for (const bad of ['x', 5, true, [], [{ max_actions: 1 }]]) {
      const result = ok(bad);
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe('action_policy');
    }
  });

  it('rejects unknown top-level fields rather than ignoring them', () => {
    // Silently dropping a field the caller believed was enforcement is the
    // worst possible failure mode for a security control.
    expect(paths({ blocked_keyz: ['escape'] })).toContain('action_policy.blocked_keyz');
  });
});

describe('validateActionPolicy — action lists', () => {
  it('accepts a normal allow/deny pair', () => {
    expect(ok({ allowed_actions: ['click', 'type_text'], blocked_actions: ['drag'] }).valid).toBe(
      true,
    );
  });

  it('enforces the documented 1..128 bound on allowed_actions', () => {
    expect(ok({ allowed_actions: [] }).valid).toBe(false);
    const max = ACTION_POLICY_LIMITS.maxAllowedActions;
    expect(ok({ allowed_actions: Array.from({ length: max }, (_, i) => `a${i}`) }).valid).toBe(
      true,
    );
    expect(ok({ allowed_actions: Array.from({ length: max + 1 }, (_, i) => `a${i}`) }).valid).toBe(
      false,
    );
  });

  it('caps blocked_actions at 128 but allows an empty denylist', () => {
    expect(ok({ blocked_actions: [] }).valid).toBe(true);
    const over = Array.from(
      { length: ACTION_POLICY_LIMITS.maxBlockedActions + 1 },
      (_, i) => `b${i}`,
    );
    expect(ok({ blocked_actions: over }).valid).toBe(false);
  });

  it('rejects overlap between allowed_actions and blocked_actions', () => {
    const result = ok({ allowed_actions: ['click', 'drag'], blocked_actions: ['drag'] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('drag');
  });

  it('rejects empty and non-string entries', () => {
    expect(paths({ allowed_actions: ['click', ''] })).toContain('action_policy.allowed_actions[1]');
    expect(paths({ allowed_actions: ['click', 42] })).toContain('action_policy.allowed_actions[1]');
  });

  it('flags duplicates inside a single list', () => {
    expect(ok({ blocked_actions: ['drag', 'drag'] }).valid).toBe(false);
  });

  it('flags an allowlist made only of terminal signals as permitting no work', () => {
    // done/fail/awaiting_human are always available, so allowing ONLY them
    // yields a policy under which the agent can never act.
    const result = ok({ allowed_actions: ['done', 'fail'] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/permits no work/);
  });

  it('does not flag terminal signals when real actions are also allowed', () => {
    expect(ok({ allowed_actions: ['done', 'click'] }).valid).toBe(true);
  });
});

describe('validateActionPolicy — blocked_keys aliasing', () => {
  it("normalizes case and aliases 'esc' to 'escape'", () => {
    expect(normalizeBlockedKey('ESC')).toBe('escape');
    expect(normalizeBlockedKey('  Escape ')).toBe('escape');
    expect(normalizeBlockedKey('Enter')).toBe('enter');
  });

  it('flags two spellings that collapse to the same canonical key', () => {
    const result = ok({ blocked_keys: ['esc', 'escape'] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('escape');
  });

  it('does not flag the same spelling twice as an alias collision', () => {
    // It is a duplicate, which the list check already reports — but the alias
    // check must not double-report it with a confusing "both normalize to" message.
    const messages = validateActionPolicy({ blocked_keys: ['esc', 'esc'] }).issues.map(
      (i) => i.message,
    );
    expect(messages.some((m) => m.includes('duplicate'))).toBe(true);
    expect(messages.some((m) => m.includes('both normalize to'))).toBe(false);
  });

  it('caps blocked_keys at 128', () => {
    const over = Array.from({ length: ACTION_POLICY_LIMITS.maxBlockedKeys + 1 }, (_, i) => `k${i}`);
    expect(ok({ blocked_keys: over }).valid).toBe(false);
  });
});

describe('validateActionPolicy — max_actions', () => {
  it('accepts the inclusive 1..10000 range and rejects just outside it', () => {
    expect(ok({ max_actions: ACTION_POLICY_LIMITS.minMaxActions }).valid).toBe(true);
    expect(ok({ max_actions: ACTION_POLICY_LIMITS.maxMaxActions }).valid).toBe(true);
    expect(ok({ max_actions: 0 }).valid).toBe(false);
    expect(ok({ max_actions: ACTION_POLICY_LIMITS.maxMaxActions + 1 }).valid).toBe(false);
  });

  it('rejects non-integers, including numeric strings and NaN', () => {
    for (const bad of [1.5, '5', NaN, Infinity, null]) {
      expect(ok({ max_actions: bad }).valid).toBe(false);
    }
  });
});

describe('validateActionPolicy — coordinate_bounds', () => {
  const bounds = { min_x: 0, min_y: 0, max_x: 1279, max_y: 719 };

  it('accepts a well-formed rectangle', () => {
    expect(ok({ coordinate_bounds: bounds }).valid).toBe(true);
  });

  it('accepts a degenerate one-pixel rectangle (the rectangle is INCLUSIVE)', () => {
    expect(ok({ coordinate_bounds: { min_x: 10, min_y: 10, max_x: 10, max_y: 10 } }).valid).toBe(
      true,
    );
  });

  it('rejects an inverted rectangle on either axis', () => {
    expect(ok({ coordinate_bounds: { ...bounds, min_x: 5, max_x: 4 } }).valid).toBe(false);
    expect(ok({ coordinate_bounds: { ...bounds, min_y: 5, max_y: 4 } }).valid).toBe(false);
  });

  it('requires all four corners', () => {
    for (const missing of ['min_x', 'min_y', 'max_x', 'max_y'] as const) {
      const partial: Record<string, number> = { ...bounds };
      delete partial[missing];
      expect(paths({ coordinate_bounds: partial })).toContain(
        `action_policy.coordinate_bounds.${missing}`,
      );
    }
  });

  it('rejects non-finite coordinates and unknown corner fields', () => {
    expect(ok({ coordinate_bounds: { ...bounds, max_x: Infinity } }).valid).toBe(false);
    expect(paths({ coordinate_bounds: { ...bounds, mid_x: 4 } })).toContain(
      'action_policy.coordinate_bounds.mid_x',
    );
  });

  it('accepts negative coordinates (multi-monitor origins are legitimately negative)', () => {
    expect(
      ok({ coordinate_bounds: { min_x: -1920, min_y: -100, max_x: 0, max_y: 1080 } }).valid,
    ).toBe(true);
  });
});

describe('canonicalizeActionPolicy', () => {
  it('produces a stable, hashable form regardless of input ordering', () => {
    const a: ActionPolicy = {
      blocked_keys: ['ESC', 'Enter'],
      allowed_actions: ['type_text', 'click'],
      max_actions: 5,
    };
    const b: ActionPolicy = {
      max_actions: 5,
      allowed_actions: ['click', 'type_text'],
      blocked_keys: ['enter', 'escape'],
    };
    expect(JSON.stringify(canonicalizeActionPolicy(a))).toBe(
      JSON.stringify(canonicalizeActionPolicy(b)),
    );
  });

  it('collapses esc/escape to one canonical key', () => {
    expect(canonicalizeActionPolicy({ blocked_keys: ['esc', 'ESCAPE'] }).blocked_keys).toEqual([
      'escape',
    ]);
  });

  it('omits absent fields rather than filling in defaults', () => {
    // The canonical form is an audit record of what was SUBMITTED. Inventing
    // `block_window_close: false` would misrepresent the submission.
    expect(canonicalizeActionPolicy({ max_actions: 3 })).toEqual({ max_actions: 3 });
  });

  it('preserves an explicit false for block_window_close', () => {
    expect(canonicalizeActionPolicy({ block_window_close: false })).toEqual({
      block_window_close: false,
    });
  });

  it('copies coordinate_bounds by value, not by reference', () => {
    const source: ActionPolicy = {
      coordinate_bounds: { min_x: 0, min_y: 0, max_x: 10, max_y: 10 },
    };
    const canonical = canonicalizeActionPolicy(source);
    source.coordinate_bounds!.max_x = 999;
    expect(canonical.coordinate_bounds?.max_x).toBe(10);
  });
});
