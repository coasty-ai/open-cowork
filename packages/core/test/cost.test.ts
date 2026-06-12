import { describe, expect, it } from 'vitest';
import {
  formatCents,
  groundCallCents,
  isHdImage,
  machineRuntimeCentsPerHour,
  predictCallCents,
  runEstimateCents,
  runStepCents,
  sessionStepCents,
  workflowEstimateCents,
  PRICING,
  type WorkflowDefinition,
} from '../src/index';

describe('pricing table matches the documented numbers', () => {
  it('base prices', () => {
    expect(PRICING.predictBaseCents).toBe(5);
    expect(PRICING.sessionCreateCents).toBe(10);
    expect(PRICING.sessionStepCents).toBe(4);
    expect(PRICING.groundCents).toBe(3);
    expect(PRICING.parseCents).toBe(0);
    expect(PRICING.snapshotCents).toBe(1);
    expect(PRICING.provisioningGateCents).toBe(20);
  });
});

describe('isHdImage — strict boundary per docs', () => {
  it('exactly 1280x720 is NOT HD', () => {
    expect(isHdImage(1280, 720)).toBe(false);
  });
  it('1281x720 IS HD (width strictly greater)', () => {
    expect(isHdImage(1281, 720)).toBe(true);
  });
  it('1280x721 IS HD (height strictly greater)', () => {
    expect(isHdImage(1280, 721)).toBe(true);
  });
  it('small images are not HD', () => {
    expect(isHdImage(640, 360)).toBe(false);
  });
});

describe('predictCallCents', () => {
  it('plain v3 call: $0.05', () => {
    expect(predictCallCents()).toBe(5);
  });
  it('v1 engine adds 3 cents', () => {
    expect(predictCallCents({ cuaVersion: 'v1' })).toBe(8);
  });
  it('v4 adds nothing', () => {
    expect(predictCallCents({ cuaVersion: 'v4' })).toBe(5);
  });
  it('+2 per trajectory image', () => {
    expect(predictCallCents({ trajectoryCount: 3 })).toBe(5 + 6);
  });
  it('+1 for HD current screenshot', () => {
    expect(predictCallCents({ currentHd: true })).toBe(6);
  });
  it('+1 per HD trajectory image', () => {
    expect(predictCallCents({ trajectoryCount: 2, trajectoryHdCount: 2, currentHd: true })).toBe(
      5 + 4 + 2 + 1,
    );
  });
  it('system prompt exactly 500 chars is free', () => {
    expect(predictCallCents({ systemPromptChars: 500 })).toBe(5);
  });
  it('system prompt 501 chars adds 1 cent', () => {
    expect(predictCallCents({ systemPromptChars: 501 })).toBe(6);
  });
  it('docs example: 6 credits = base + HD', () => {
    // The /v1/predict example response shows credits_charged: 6 (1920x1080 → HD)
    expect(predictCallCents({ currentHd: true })).toBe(6);
  });
});

describe('sessionStepCents', () => {
  it('base session step: $0.04', () => {
    expect(sessionStepCents()).toBe(4);
  });
  it('same surcharges as predict', () => {
    expect(sessionStepCents({ cuaVersion: 'v1', trajectoryCount: 1, currentHd: true })).toBe(
      4 + 3 + 2 + 1,
    );
  });
});

describe('groundCallCents', () => {
  it('$0.03 base, +$0.01 HD', () => {
    expect(groundCallCents()).toBe(3);
    expect(groundCallCents({ hd: true })).toBe(4);
  });
});

describe('runStepCents / runEstimateCents', () => {
  it('v3/v4 step $0.05, v1 step $0.08', () => {
    expect(runStepCents('v3')).toBe(5);
    expect(runStepCents('v4')).toBe(5);
    expect(runStepCents('v1')).toBe(8);
  });
  it('estimates min one step, max maxSteps', () => {
    expect(runEstimateCents({ cuaVersion: 'v3', maxSteps: 40 })).toEqual({
      perStepCents: 5,
      minCents: 5,
      maxCents: 200,
    });
  });
  it('default maxSteps is the documented 50', () => {
    expect(runEstimateCents({}).maxCents).toBe(250);
  });
});

describe('workflowEstimateCents', () => {
  const task = (id: string) => ({ id, type: 'task' as const, task: 'do something' });

  it('counts flat task steps; control flow is free', () => {
    const def: WorkflowDefinition = {
      steps: [
        task('a'),
        { id: 'check', type: 'assert', condition: { op: 'truthy', value: true } },
        task('b'),
        { id: 'ok', type: 'succeed' },
      ],
    };
    const est = workflowEstimateCents(def, { assumedStepsPerTask: 4 });
    expect(est.taskCount).toBe(2);
    expect(est.typicalCents).toBe(2 * 4 * 5);
  });

  it('loop with count multiplies the body', () => {
    const def: WorkflowDefinition = {
      steps: [{ id: 'l', type: 'loop', count: 3, body: [task('t')] }],
    };
    expect(workflowEstimateCents(def).taskCount).toBe(3);
  });

  it('retry multiplies the worst case only', () => {
    const def: WorkflowDefinition = {
      steps: [{ id: 'r', type: 'retry', max_attempts: 5, body: [task('t')] }],
    };
    const est = workflowEstimateCents(def, { assumedStepsPerTask: 1 });
    expect(est.typicalCents).toBe(1 * 1 * 5);
    expect(est.worstCaseCents).toBe(5 * 1 * 5);
  });

  it('if takes the max of branches; parallel sums branches', () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'i',
          type: 'if',
          condition: { op: 'truthy', value: true },
          then: [task('a'), task('b')],
          else: [task('c')],
        },
        { id: 'p', type: 'parallel', branches: [[task('d')], [task('e')]] },
      ],
    };
    expect(workflowEstimateCents(def).taskCount).toBe(2 + 2);
  });

  it('while loops use the assumed iteration bound', () => {
    const def: WorkflowDefinition = {
      steps: [{ id: 'w', type: 'loop', while: { op: 'truthy', value: true }, body: [task('t')] }],
    };
    expect(workflowEstimateCents(def, { assumedWhileIterations: 7 }).taskCount).toBe(7);
  });

  it('v1 engine rates apply', () => {
    const def: WorkflowDefinition = { steps: [task('a')] };
    expect(
      workflowEstimateCents(def, { cuaVersion: 'v1', assumedStepsPerTask: 2 }).typicalCents,
    ).toBe(16);
  });
});

describe('machineRuntimeCentsPerHour — documented rates', () => {
  it('linux running $0.05/hr, windows $0.09/hr, stopped $0.01/hr, terminated free', () => {
    expect(machineRuntimeCentsPerHour('linux', 'running')).toBe(5);
    expect(machineRuntimeCentsPerHour('windows', 'running')).toBe(9);
    expect(machineRuntimeCentsPerHour('linux', 'stopped')).toBe(1);
    expect(machineRuntimeCentsPerHour('windows', 'stopped')).toBe(1);
    expect(machineRuntimeCentsPerHour('linux', 'terminated')).toBe(0);
    expect(machineRuntimeCentsPerHour('linux', 'creating')).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(123)).toBe('$1.23');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(10000)).toBe('$100.00');
    expect(formatCents(-42)).toBe('-$0.42');
  });
});
