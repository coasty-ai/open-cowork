/**
 * Characterisation of the end-of-step branch in `runAgentLoop`.
 *
 * Three variables decide a step's outcome: whether an action threw, what the
 * model reported, and whether the failure count reached the threshold. This
 * enumerates that space so a change to the branch is judged by which cells move
 * — a test written only for the bug would be satisfied by a fix that broke the
 * retry threshold or the clean-run path.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  type AgentScreen,
  type CuaAction,
  type PredictStepFn,
} from '../src/index';

const click = (x = 10, y = 20): CuaAction => ({ action_type: 'click', params: { x, y } });

function screen(opts: { throwOn?: (n: number) => boolean } = {}): AgentScreen {
  let n = 0;
  return {
    screenshot: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
    execute: async () => {
      n += 1;
      if (opts.throwOn?.(n)) throw new Error('bridge lost the window');
    },
  };
}

/** A model that says `status` every step and always emits one executable action. */
function saying(status: 'done' | 'fail' | 'continue'): PredictStepFn {
  return async () => ({ status, actions: [click()], reasoning: `model says ${status}` });
}

type Cell = {
  name: string;
  failing: boolean;
  status: 'done' | 'fail' | 'continue';
  maxSteps: number;
  maxConsecutiveFailures: number;
};

const CELLS: Cell[] = [
  // ---- nothing failed: the paths that must not move ----
  { name: 'clean + done',              failing: false, status: 'done',       maxSteps: 1, maxConsecutiveFailures: 3 },
  { name: 'clean + fail',              failing: false, status: 'fail',       maxSteps: 1, maxConsecutiveFailures: 3 },
  { name: 'clean + continue',        failing: false, status: 'continue', maxSteps: 1, maxConsecutiveFailures: 3 },
  // ---- an action threw, failure count BELOW the threshold ----
  { name: 'threw + done (below cap)',  failing: true,  status: 'done',       maxSteps: 1, maxConsecutiveFailures: 3 },
  { name: 'threw + fail (below cap)',  failing: true,  status: 'fail',       maxSteps: 1, maxConsecutiveFailures: 3 },
  { name: 'threw + continue (below)',failing: true,  status: 'continue', maxSteps: 1, maxConsecutiveFailures: 3 },
  // ---- an action threw and the threshold is reached on this step ----
  { name: 'threw + done (at cap)',     failing: true,  status: 'done',       maxSteps: 1, maxConsecutiveFailures: 1 },
  { name: 'threw + continue (at cap)',failing: true, status: 'continue', maxSteps: 1, maxConsecutiveFailures: 1 },
];

/**
 * The full outcome space, and the single cell this change moves.
 *
 * Seven of the eight are asserted to be UNCHANGED by the fix — that is the point
 * of the table. A test written only for the bug would be satisfied by a change
 * that quietly broke the retry threshold or the clean-run path.
 *
 *   cell                          before        after
 *   threw + done (below cap)      done          max_steps   ← the defect
 *   everything else               unchanged     unchanged
 */
const EXPECTED: Record<string, string> = {
  'clean + done': 'done',
  'clean + fail': 'fail',
  'clean + continue': 'max_steps',
  // Was `done` before the fix: a step that threw reported success.
  'threw + done (below cap)': 'max_steps',
  'threw + fail (below cap)': 'fail',
  'threw + continue (below)': 'max_steps',
  'threw + done (at cap)': 'fail',
  'threw + continue (at cap)': 'fail',
};

async function run(c: Cell): Promise<string> {
  const outcome = await runAgentLoop({
    screen: screen(c.failing ? { throwOn: () => true } : {}),
    predictStep: saying(c.status),
    task: 'characterisation',
    settleMs: 0,
    maxSteps: c.maxSteps,
    maxConsecutiveFailures: c.maxConsecutiveFailures,
  });
  return outcome.status;
}

describe('runAgentLoop end-of-step outcome matrix', () => {
  for (const c of CELLS) {
    it(`${c.name} → ${EXPECTED[c.name]}`, async () => {
      expect(await run(c)).toBe(EXPECTED[c.name]);
    });
  }
});
