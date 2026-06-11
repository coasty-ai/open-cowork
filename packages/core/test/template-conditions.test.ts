import { describe, expect, it } from 'vitest';
import { evaluateCondition, resolveDeep, resolvePath, resolveTemplate, type Condition } from '../src/index';

const scope = {
  inputs: { order_id: 'ord_4821', amount: 25, flag: false },
  vars: { attempt: 2 },
  invoice: { passed: true, result: 'Invoice PAID, total $25.00', steps: 4, tags: ['a', 'b'] },
};

describe('resolvePath / resolveTemplate', () => {
  it('resolves dotted paths', () => {
    expect(resolvePath('inputs.order_id', scope)).toBe('ord_4821');
    expect(resolvePath('invoice.passed', scope)).toBe(true);
  });
  it('missing path → undefined', () => {
    expect(resolvePath('inputs.nope.deeper', scope)).toBeUndefined();
    expect(resolvePath('ghost.x', scope)).toBeUndefined();
  });
  it('full-string ref returns the RAW value preserving type', () => {
    expect(resolveTemplate('{{invoice.passed}}', scope)).toBe(true);
    expect(resolveTemplate('{{inputs.amount}}', scope)).toBe(25);
    expect(resolveTemplate('{{invoice.tags}}', scope)).toEqual(['a', 'b']);
    expect(resolveTemplate('{{ inputs.order_id }}', scope)).toBe('ord_4821'); // whitespace tolerated
  });
  it('full-string ref of a missing path → undefined', () => {
    expect(resolveTemplate('{{missing.path}}', scope)).toBeUndefined();
  });
  it('embedded refs interpolate as strings', () => {
    expect(resolveTemplate('Open order {{inputs.order_id}} now', scope)).toBe('Open order ord_4821 now');
    expect(resolveTemplate('{{inputs.amount}} dollars on attempt {{vars.attempt}}', scope)).toBe(
      '25 dollars on attempt 2',
    );
  });
  it('embedded missing refs interpolate as empty string', () => {
    expect(resolveTemplate('a {{nope}} b', scope)).toBe('a  b');
  });
  it('embedded object refs interpolate as JSON', () => {
    expect(resolveTemplate('tags: {{invoice.tags}}', scope)).toBe('tags: ["a","b"]');
  });
  it('non-strings pass through unchanged', () => {
    expect(resolveTemplate(42, scope)).toBe(42);
    expect(resolveTemplate(null, scope)).toBeNull();
  });
});

describe('resolveDeep', () => {
  it('resolves nested objects and arrays', () => {
    expect(
      resolveDeep(
        { a: '{{inputs.amount}}', list: ['{{invoice.passed}}', 'x {{vars.attempt}}'], n: 1 },
        scope,
      ),
    ).toEqual({ a: 25, list: [true, 'x 2'], n: 1 });
  });
});

describe('evaluateCondition — all 13 ops', () => {
  const t = (cond: Condition) => evaluateCondition(cond, scope);

  it('eq / ne (no string-number coercion)', () => {
    expect(t({ op: 'eq', left: '{{inputs.amount}}', right: 25 })).toBe(true);
    expect(t({ op: 'eq', left: '{{inputs.amount}}', right: '25' })).toBe(false);
    expect(t({ op: 'eq', left: 'a', right: 'a' })).toBe(true);
    expect(t({ op: 'ne', left: '{{inputs.order_id}}', right: 'other' })).toBe(true);
    expect(t({ op: 'eq', left: '{{invoice.tags}}', right: ['a', 'b'] })).toBe(true);
  });

  it('lt / gt / lte / gte with numeric coercion of numeric strings', () => {
    expect(t({ op: 'lt', left: '{{inputs.amount}}', right: 26 })).toBe(true);
    expect(t({ op: 'gt', left: '{{inputs.amount}}', right: 24 })).toBe(true);
    expect(t({ op: 'lte', left: 25, right: '{{inputs.amount}}' })).toBe(true);
    expect(t({ op: 'gte', left: '{{inputs.amount}}', right: 25 })).toBe(true);
    expect(t({ op: 'lt', left: '10', right: '9' })).toBe(false);
    expect(t({ op: 'lt', left: '2', right: '10' })).toBe(true); // numeric, not lexicographic
  });

  it('ordered ops with non-numeric operands → false', () => {
    expect(t({ op: 'lt', left: 'abc', right: 5 })).toBe(false);
    expect(t({ op: 'gte', left: '{{invoice.result}}', right: 1 })).toBe(false);
  });

  it('contains: substring + array membership', () => {
    expect(t({ op: 'contains', left: '{{invoice.result}}', right: 'PAID' })).toBe(true);
    expect(t({ op: 'contains', left: '{{invoice.result}}', right: 'REFUND' })).toBe(false);
    expect(t({ op: 'contains', left: '{{invoice.tags}}', right: 'b' })).toBe(true);
    expect(t({ op: 'contains', left: '{{invoice.tags}}', right: 'z' })).toBe(false);
    expect(t({ op: 'contains', left: 42, right: '4' })).toBe(false);
  });

  it('truthy / falsy / exists', () => {
    expect(t({ op: 'truthy', value: '{{invoice.passed}}' })).toBe(true);
    expect(t({ op: 'truthy', value: '{{inputs.flag}}' })).toBe(false);
    expect(t({ op: 'falsy', value: '{{inputs.flag}}' })).toBe(true);
    expect(t({ op: 'exists', value: '{{inputs.flag}}' })).toBe(true); // false but present
    expect(t({ op: 'exists', value: '{{missing.path}}' })).toBe(false);
    expect(t({ op: 'truthy', value: '{{missing.path}}' })).toBe(false);
  });

  it('and / or / not, nested', () => {
    expect(
      t({
        op: 'and',
        conditions: [
          { op: 'truthy', value: '{{invoice.passed}}' },
          { op: 'contains', left: '{{invoice.result}}', right: 'PAID' },
        ],
      }),
    ).toBe(true);
    expect(
      t({
        op: 'or',
        conditions: [
          { op: 'truthy', value: '{{inputs.flag}}' },
          { op: 'eq', left: 1, right: 2 },
        ],
      }),
    ).toBe(false);
    expect(t({ op: 'not', condition: { op: 'truthy', value: '{{inputs.flag}}' } })).toBe(true);
    // and(truthy(true)=T, not(falsy(true)=F)=T) = T → not(T) = false
    expect(
      t({
        op: 'not',
        condition: {
          op: 'and',
          conditions: [
            { op: 'truthy', value: true },
            { op: 'not', condition: { op: 'falsy', value: true } },
          ],
        },
      }),
    ).toBe(false);
  });

  it('unknown op throws (validation rejects earlier in real flows)', () => {
    expect(() => evaluateCondition({ op: 'regex' } as unknown as Condition, scope)).toThrow(/Unknown condition op/);
  });
});
