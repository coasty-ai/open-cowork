import { describe, expect, it } from 'vitest';
import {
  validateWorkflowDefinition,
  MAX_PARALLEL_BRANCHES,
  MAX_TOTAL_STEPS,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../src/index';

const task = (id: string): WorkflowStep => ({ id, type: 'task', task: 'do it' });

function expectIssue(def: unknown, code: string): void {
  const result = validateWorkflowDefinition(def);
  expect(result.valid).toBe(false);
  expect(result.issues.map((i) => i.code)).toContain(code);
}

describe('validateWorkflowDefinition', () => {
  it('accepts the documented example workflow', () => {
    const def: WorkflowDefinition = {
      steps: [
        { id: 'fetch', type: 'task', task: 'Open order {{inputs.order_id}}', save_as: 'invoice' },
        {
          id: 'check',
          type: 'assert',
          condition: { op: 'truthy', value: '{{invoice.passed}}' },
          message: 'Agent failed to read the invoice',
        },
        {
          id: 'branch',
          type: 'if',
          condition: { op: 'contains', left: '{{invoice.result}}', right: 'PAID' },
          then: [{ id: 'ok', type: 'succeed', output: { state: 'paid' } }],
          else: [{ id: 'no', type: 'fail', message: 'Invoice not marked paid' }],
        },
      ],
      output: { paid: '{{invoice.result}}' },
    };
    expect(validateWorkflowDefinition(def)).toEqual({ valid: true, issues: [] });
  });

  it('rejects non-object definitions and missing/empty steps', () => {
    expectIssue(null, 'MISSING_STEPS');
    expectIssue('nope', 'MISSING_STEPS');
    expectIssue({}, 'MISSING_STEPS');
    expectIssue({ steps: [] }, 'MISSING_STEPS');
  });

  it('rejects bad ids and duplicate ids (including across nesting)', () => {
    expectIssue({ steps: [{ id: 'has space', type: 'task', task: 'x' }] }, 'INVALID_ID');
    expectIssue({ steps: [{ id: 'a'.repeat(65), type: 'task', task: 'x' }] }, 'INVALID_ID');
    expectIssue({ steps: [{ id: '', type: 'task', task: 'x' }] }, 'INVALID_ID');
    expectIssue({ steps: [task('dup'), task('dup')] }, 'DUPLICATE_ID');
    expectIssue(
      {
        steps: [
          task('dup'),
          { id: 'i', type: 'if', condition: { op: 'truthy', value: 1 }, then: [task('dup')] },
        ],
      },
      'DUPLICATE_ID',
    );
  });

  it('rejects unknown step types and non-object steps', () => {
    expectIssue({ steps: [{ id: 'x', type: 'teleport' }] }, 'UNKNOWN_TYPE');
    expectIssue({ steps: ['not-a-step'] }, 'INVALID_STEP');
  });

  it('task: requires task text; save_as must not shadow reserved namespaces', () => {
    expectIssue({ steps: [{ id: 't', type: 'task' }] }, 'MISSING_FIELD');
    expectIssue({ steps: [{ id: 't', type: 'task', task: '' }] }, 'MISSING_FIELD');
    expectIssue({ steps: [{ id: 't', type: 'task', task: 'x', save_as: 'inputs' }] }, 'RESERVED_SAVE_AS');
    expectIssue({ steps: [{ id: 't', type: 'task', task: 'x', save_as: 'vars' }] }, 'RESERVED_SAVE_AS');
  });

  it('assert/if: condition required and structurally valid', () => {
    expectIssue({ steps: [{ id: 'a', type: 'assert' }] }, 'MISSING_FIELD');
    expectIssue({ steps: [{ id: 'a', type: 'assert', condition: { op: 'regex' } }] }, 'INVALID_CONDITION');
    expectIssue({ steps: [{ id: 'a', type: 'assert', condition: { op: 'eq', left: 1 } }] }, 'INVALID_CONDITION');
    expectIssue({ steps: [{ id: 'a', type: 'assert', condition: { op: 'and', conditions: [] } }] }, 'INVALID_CONDITION');
    expectIssue({ steps: [{ id: 'i', type: 'if', condition: { op: 'truthy', value: 1 } }] }, 'MISSING_FIELD');
    expectIssue(
      { steps: [{ id: 'i', type: 'if', condition: { op: 'not' }, then: [] }] },
      'INVALID_CONDITION',
    );
    // nested condition validation
    expectIssue(
      {
        steps: [
          {
            id: 'a',
            type: 'assert',
            condition: { op: 'or', conditions: [{ op: 'truthy', value: 1 }, { op: 'nope' }] },
          },
        ],
      },
      'INVALID_CONDITION',
    );
  });

  it('loop: exactly one of count|while; body required', () => {
    expectIssue({ steps: [{ id: 'l', type: 'loop', body: [] }] }, 'INVALID_LOOP');
    expectIssue(
      { steps: [{ id: 'l', type: 'loop', count: 2, while: { op: 'truthy', value: 1 }, body: [] }] },
      'INVALID_LOOP',
    );
    expectIssue({ steps: [{ id: 'l', type: 'loop', count: 1.5, body: [] }] }, 'INVALID_FIELD');
    expectIssue({ steps: [{ id: 'l', type: 'loop', count: 2 }] }, 'MISSING_FIELD');
    expect(
      validateWorkflowDefinition({ steps: [{ id: 'l', type: 'loop', count: 2, body: [task('t')] }] }).valid,
    ).toBe(true);
  });

  it('retry: max_attempts must be an integer 1..20', () => {
    for (const bad of [0, 21, 2.5, -1, undefined, 'three']) {
      expectIssue({ steps: [{ id: 'r', type: 'retry', max_attempts: bad, body: [task('t')] }] }, 'INVALID_RETRY');
    }
    expect(
      validateWorkflowDefinition({
        steps: [{ id: 'r', type: 'retry', max_attempts: 20, body: [task('t')] }],
      }).valid,
    ).toBe(true);
  });

  it('parallel: branch count cap and forbidden contents at any depth', () => {
    expectIssue({ steps: [{ id: 'p', type: 'parallel' }] }, 'MISSING_FIELD');
    const tooMany = Array.from({ length: MAX_PARALLEL_BRANCHES + 1 }, (_, i) => [task(`b${i}`)]);
    expectIssue({ steps: [{ id: 'p', type: 'parallel', branches: tooMany }] }, 'TOO_MANY_BRANCHES');
    for (const forbidden of [
      { id: 'h', type: 'human_approval' },
      { id: 's', type: 'succeed' },
      { id: 'f', type: 'fail' },
    ]) {
      expectIssue(
        { steps: [{ id: 'p', type: 'parallel', branches: [[forbidden]] }] },
        'FORBIDDEN_IN_PARALLEL',
      );
    }
    // nested inside an if inside a parallel branch — still forbidden
    expectIssue(
      {
        steps: [
          {
            id: 'p',
            type: 'parallel',
            branches: [
              [
                {
                  id: 'i',
                  type: 'if',
                  condition: { op: 'truthy', value: 1 },
                  then: [{ id: 'h', type: 'human_approval' }],
                },
              ],
            ],
          },
        ],
      },
      'FORBIDDEN_IN_PARALLEL',
    );
    // but human_approval OUTSIDE parallel is fine
    expect(
      validateWorkflowDefinition({
        steps: [
          { id: 'p', type: 'parallel', branches: [[task('a')], [task('b')]] },
          { id: 'h', type: 'human_approval' },
        ],
      }).valid,
    ).toBe(true);
  });

  it('enforces the 200 total-step cap counting nested steps', () => {
    const branchOf50 = (prefix: string) => Array.from({ length: 50 }, (_, i) => task(`${prefix}${i}`));
    const def = {
      steps: [
        { id: 'p1', type: 'parallel', branches: [branchOf50('a'), branchOf50('b')] },
        { id: 'p2', type: 'parallel', branches: [branchOf50('c'), branchOf50('d')] },
      ],
    };
    // 2 parallel + 200 tasks = 202 > 200
    expectIssue(def, 'TOO_MANY_STEPS');
    expect(MAX_TOTAL_STEPS).toBe(200);
  });

  it('enforces the 8-level nesting cap', () => {
    // depth 1 = top-level steps; each loop adds one level. 8 nested loops → body at depth 9.
    let inner: WorkflowStep[] = [task('leaf')];
    for (let i = 0; i < 8; i++) {
      inner = [{ id: `loop${i}`, type: 'loop', count: 1, body: inner }];
    }
    expectIssue({ steps: inner }, 'TOO_DEEP');
    // 7 nested loops (leaf at depth 8) is allowed
    let ok: WorkflowStep[] = [task('leaf2')];
    for (let i = 0; i < 7; i++) {
      ok = [{ id: `okloop${i}`, type: 'loop', count: 1, body: ok }];
    }
    expect(validateWorkflowDefinition({ steps: ok }).valid).toBe(true);
  });

  it('collects multiple issues instead of stopping at the first', () => {
    const result = validateWorkflowDefinition({
      steps: [
        { id: 'bad id', type: 'task' },
        { id: 'r', type: 'retry', max_attempts: 99, body: [{ id: 'x', type: 'nope' }] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(result.issues.every((i) => typeof i.path === 'string' && i.path.length > 0)).toBe(true);
  });
});
