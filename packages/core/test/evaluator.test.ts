import { describe, expect, it, vi } from 'vitest';
import {
  executeWorkflow,
  type TaskStep,
  type TaskStepResult,
  type WorkflowDefinition,
} from '../src/index';

/** A runTask stub: succeeds with a canned result; tasks containing FAIL fail. */
function stubRunTask(costCents = 20) {
  const calls: { stepId: string; resolvedTask: string }[] = [];
  const runTask = async (step: TaskStep, resolvedTask: string): Promise<TaskStepResult> => {
    calls.push({ stepId: step.id, resolvedTask });
    const failed = resolvedTask.includes('FAIL');
    return {
      status: failed ? 'failed' : 'succeeded',
      passed: !failed,
      result: `Result of: ${resolvedTask}`,
      run_id: `run_${step.id}`,
      steps: 4,
      error: failed ? { code: 'TASK_FAILED', message: 'verification failed' } : null,
      costCents,
    };
  };
  return { runTask, calls };
}

const approveAll = vi.fn(async () => ({ approved: true }));

describe('executeWorkflow', () => {
  it('runs the documented example: task → assert → if/contains → succeed with output', async () => {
    const def: WorkflowDefinition = {
      steps: [
        { id: 'fetch', type: 'task', task: 'Open order {{inputs.order_id}} and read PAID status', save_as: 'invoice' },
        { id: 'check', type: 'assert', condition: { op: 'truthy', value: '{{invoice.passed}}' } },
        {
          id: 'branch',
          type: 'if',
          condition: { op: 'contains', left: '{{invoice.result}}', right: 'PAID' },
          then: [{ id: 'ok', type: 'succeed', output: { state: 'paid', order: '{{inputs.order_id}}' } }],
          else: [{ id: 'no', type: 'fail', message: 'Invoice not marked paid' }],
        },
      ],
    };
    const { runTask, calls } = stubRunTask();
    const result = await executeWorkflow({ definition: def, inputs: { order_id: 'ord_42' }, runTask });
    expect(calls[0]!.resolvedTask).toBe('Open order ord_42 and read PAID status');
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ state: 'paid', order: 'ord_42' });
    expect(result.bindings.invoice).toMatchObject({ passed: true, run_id: 'run_fetch' });
    expect(result.bindings.fetch).toBeDefined(); // bound under step id too
  });

  it('assert failure fails the workflow with the message', async () => {
    const def: WorkflowDefinition = {
      steps: [
        { id: 't', type: 'task', task: 'FAIL this', save_as: 'r' },
        { id: 'a', type: 'assert', condition: { op: 'truthy', value: '{{r.passed}}' }, message: 'task did not pass' },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask: stubRunTask().runTask });
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ code: 'ASSERTION_FAILED', message: 'task did not pass' });
  });

  it('explicit fail step', async () => {
    const def: WorkflowDefinition = {
      steps: [{ id: 'f', type: 'fail', message: 'stop {{inputs.why}}' }],
    };
    const result = await executeWorkflow({ definition: def, inputs: { why: 'here' }, runTask: stubRunTask().runTask });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'WORKFLOW_FAILED', message: 'stop here' } });
  });

  it('implicit success at the end resolves top-level output', async () => {
    const def: WorkflowDefinition = {
      steps: [{ id: 't', type: 'task', task: 'go', save_as: 'r' }],
      output: { summary: '{{r.result}}' },
    };
    const result = await executeWorkflow({ definition: def, runTask: stubRunTask().runTask });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ summary: 'Result of: go' });
  });

  it('loop with count runs the body N times and tracks iterationsUsed', async () => {
    const { runTask, calls } = stubRunTask();
    const def: WorkflowDefinition = {
      steps: [{ id: 'l', type: 'loop', count: 3, body: [{ id: 't', type: 'task', task: 'tick' }] }],
    };
    const result = await executeWorkflow({ definition: def, runTask });
    expect(calls).toHaveLength(3);
    expect(result.iterationsUsed).toBe(3);
  });

  it('while loop re-evaluates its condition against updated bindings', async () => {
    let n = 0;
    const runTask = async (_step: TaskStep): Promise<TaskStepResult> => {
      n++;
      return {
        status: 'succeeded',
        passed: true,
        result: n >= 3 ? 'STOP' : 'GO',
        run_id: `r${n}`,
        steps: 1,
        error: null,
        costCents: 0,
      };
    };
    const def: WorkflowDefinition = {
      steps: [
        { id: 'seed', type: 'task', task: 'first', save_as: 'last' },
        {
          id: 'w',
          type: 'loop',
          while: { op: 'ne', left: '{{last.result}}', right: 'STOP' },
          body: [{ id: 'again', type: 'task', task: 'next', save_as: 'last' }],
        },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask });
    expect(result.status).toBe('succeeded');
    expect(n).toBe(3); // seed + 2 loop iterations (3rd result STOP read on re-check)
    expect(result.iterationsUsed).toBe(2);
  });

  it('parallel branches run concurrently and both bind results', async () => {
    const order: string[] = [];
    const runTask = async (step: TaskStep): Promise<TaskStepResult> => {
      order.push(`start-${step.id}`);
      await new Promise((r) => setTimeout(r, step.id === 'slow' ? 20 : 1));
      order.push(`end-${step.id}`);
      return { status: 'succeeded', passed: true, result: step.id, run_id: step.id, steps: 1, error: null };
    };
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'p',
          type: 'parallel',
          branches: [
            [{ id: 'slow', type: 'task', task: 'slow', save_as: 'slowR' }],
            [{ id: 'fast', type: 'task', task: 'fast', save_as: 'fastR' }],
          ],
        },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask });
    expect(result.bindings.slowR).toBeDefined();
    expect(result.bindings.fastR).toBeDefined();
    // fast finished before slow → true concurrency, not sequential
    expect(order.indexOf('end-fast')).toBeLessThan(order.indexOf('end-slow'));
  });

  it('retry: succeeds on a later attempt and exposes vars.attempt', async () => {
    let attempts = 0;
    const runTask = async (): Promise<TaskStepResult> => {
      attempts++;
      return {
        status: attempts < 3 ? 'failed' : 'succeeded',
        passed: attempts >= 3,
        result: attempts,
        run_id: `r${attempts}`,
        steps: 1,
        error: null,
      };
    };
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'r',
          type: 'retry',
          max_attempts: 5,
          body: [
            { id: 't', type: 'task', task: 'flaky', save_as: 'out' },
            { id: 'a', type: 'assert', condition: { op: 'truthy', value: '{{out.passed}}' } },
          ],
        },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask });
    expect(result.status).toBe('succeeded');
    expect(attempts).toBe(3);
  });

  it('retry: exhausting attempts fails the workflow', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'r',
          type: 'retry',
          max_attempts: 2,
          body: [
            { id: 't', type: 'task', task: 'FAIL always', save_as: 'out' },
            { id: 'a', type: 'assert', condition: { op: 'truthy', value: '{{out.passed}}' } },
          ],
        },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask: stubRunTask().runTask });
    expect(result.status).toBe('failed');
  });

  it('human_approval: approved continues, rejected fails, absent handler fails closed', async () => {
    const def: WorkflowDefinition = {
      steps: [
        { id: 'h', type: 'human_approval', message: 'OK for {{inputs.who}}?' },
        { id: 's', type: 'succeed', output: { done: true } },
      ],
    };
    const { runTask } = stubRunTask();

    const approved = await executeWorkflow({
      definition: def,
      inputs: { who: 'me' },
      runTask,
      onApproval: async (_step, message) => {
        expect(message).toBe('OK for me?');
        return { approved: true };
      },
    });
    expect(approved.status).toBe('succeeded');

    const rejected = await executeWorkflow({
      definition: def,
      runTask,
      onApproval: async () => ({ approved: false, note: 'nope' }),
    });
    expect(rejected).toMatchObject({ status: 'failed', error: { code: 'APPROVAL_REJECTED', message: 'nope' } });

    const noHandler = await executeWorkflow({ definition: def, runTask });
    expect(noHandler.status).toBe('failed');
  });

  it('guard: budget_cents stops the workflow with GUARD_EXCEEDED', async () => {
    const { runTask } = stubRunTask(60); // 60 cents per task
    const def: WorkflowDefinition = {
      steps: [
        { id: 'a', type: 'task', task: 'one' },
        { id: 'b', type: 'task', task: 'two' },
        { id: 'c', type: 'task', task: 'three' },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask, guards: { budgetCents: 100 } });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('GUARD_EXCEEDED');
    expect(result.spentCents).toBe(120); // stopped after the breaching task
  });

  it('guard: budget of 0 means uncapped per docs', async () => {
    const { runTask } = stubRunTask(60);
    const def: WorkflowDefinition = {
      steps: [
        { id: 'a', type: 'task', task: 'one' },
        { id: 'b', type: 'task', task: 'two' },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask, guards: { budgetCents: 0 } });
    expect(result.status).toBe('succeeded');
  });

  it('guard: max_iterations stops a runaway while-loop', async () => {
    const { runTask } = stubRunTask(0);
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'w',
          type: 'loop',
          while: { op: 'truthy', value: true },
          body: [{ id: 't', type: 'task', task: 'spin' }],
        },
      ],
    };
    const result = await executeWorkflow({ definition: def, runTask, guards: { maxIterations: 5 } });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'GUARD_EXCEEDED' } });
    expect(result.iterationsUsed).toBe(6); // breach detected on the 6th
  });

  it('guard: deadline_seconds enforced via the injected clock', async () => {
    let fakeNow = 0;
    const runTask = async (): Promise<TaskStepResult> => {
      fakeNow += 30_000; // each task "takes" 30s
      return { status: 'succeeded', passed: true, result: 'ok', run_id: 'r', steps: 1, error: null };
    };
    const def: WorkflowDefinition = {
      steps: [
        { id: 'a', type: 'task', task: 'one' },
        { id: 'b', type: 'task', task: 'two' },
        { id: 'c', type: 'task', task: 'three' },
      ],
    };
    const result = await executeWorkflow({
      definition: def,
      runTask,
      guards: { deadlineSeconds: 45 },
      now: () => fakeNow,
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'GUARD_EXCEEDED' } });
  });

  it('invalid definitions fail fast with VALIDATION_ERROR', async () => {
    const result = await executeWorkflow({
      definition: { steps: [{ id: 'x', type: 'nope' }] } as unknown as WorkflowDefinition,
      runTask: stubRunTask().runTask,
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'VALIDATION_ERROR' } });
  });

  it('emits lifecycle events in order', async () => {
    const events: string[] = [];
    const def: WorkflowDefinition = {
      steps: [
        { id: 't', type: 'task', task: 'go', save_as: 'r' },
        { id: 'h', type: 'human_approval' },
        { id: 's', type: 'succeed' },
      ],
    };
    await executeWorkflow({
      definition: def,
      runTask: stubRunTask().runTask,
      onApproval: approveAll,
      onEvent: (e) => events.push(e.type === 'step-start' ? `start:${e.stepId}` : e.type),
    });
    expect(events).toEqual([
      'start:t',
      'task-result',
      'step-finish',
      'start:h',
      'awaiting-approval',
      'approval-decision',
      'step-finish',
      'start:s',
    ]);
  });
});
