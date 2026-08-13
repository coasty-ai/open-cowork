/**
 * A step whose action throws must not finish as `done`.
 *
 * `stepHadFailure` only becomes a `fail` outcome at the consecutive-failure
 * threshold. Below it, control falls through to the unconditional
 * `status === 'done'` return, so a step that threw still reports success. The
 * failure shows on the event stream as `action-error` and is absent from the
 * outcome — the wrong way round when the outcome is what gets audited.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentScreen,
  type CuaAction,
  type PredictStepFn,
} from '../src/index';

const click = (x = 10, y = 20): CuaAction => ({ action_type: 'click', params: { x, y } });

/** A screen whose every action throws. */
function throwingScreen(): AgentScreen {
  return {
    screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
    execute: async () => {
      throw new Error('bridge lost the window');
    },
  };
}

/** One step: an executable action, and the model calling the task complete. */
const doneWithAction: PredictStepFn = async () => ({
  status: 'done',
  actions: [click()],
  reasoning: 'clicked save; task complete',
});

describe('a step whose action failed must not report done', () => {
  it('does not return done when execution threw on that step', async () => {
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop({
      screen: throwingScreen(),
      predictStep: doneWithAction,
      task: 'save the record',
      settleMs: 0,
      maxSteps: 1,
      onEvent: (e) => events.push(e),
    });

    // The failure is on the event stream, so the loop knows it happened...
    expect(events.some((e) => e.type === 'action-error')).toBe(true);

    // ...but the outcome claims success. This is the defect.
    expect(outcome.status).not.toBe('done');
  });

  it('still reports done when nothing failed', async () => {
    // The false-positive half: the guard must not break a genuinely clean run.
    const outcome = await runAgentLoop({
      screen: {
        screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
        execute: async () => {},
      },
      predictStep: doneWithAction,
      task: 'save the record',
      settleMs: 0,
      maxSteps: 1,
    });
    expect(outcome.status).toBe('done');
  });
});

describe('retry tolerance is preserved', () => {
  it('a step that throws then recovers still finishes done', async () => {
    // The failure the fix must NOT cause: the threshold exists so a transient
    // error can be retried. Withholding `done` on a dirty step must not turn a
    // recoverable run into a failure.
    let n = 0;
    const flaky: AgentScreen = {
      screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
      execute: async () => {
        n += 1;
        if (n === 1) throw new Error('transient bridge hiccup');
      },
    };
    const outcome = await runAgentLoop({
      screen: flaky,
      predictStep: doneWithAction,
      task: 'save the record',
      settleMs: 0,
      maxSteps: 5,
      maxConsecutiveFailures: 3,
    });
    expect(outcome.status).toBe('done');
  });
});
