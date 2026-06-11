/**
 * Cost estimation mirroring the documented Coasty pricing tables exactly
 * (llms.txt §6 Pricing, snapshot 2026-06-11). 1 credit = 1 cent = $0.01.
 * All functions return integer cents.
 */
import type { CuaVersion, MachineOsType, WorkflowDefinition, WorkflowStep } from './types';

export const PRICING = {
  /** POST /v1/predict base. */
  predictBaseCents: 5,
  /** POST /v1/sessions one-time creation. */
  sessionCreateCents: 10,
  /** POST /v1/sessions/{id}/predict per step. */
  sessionStepCents: 4,
  /** POST /v1/ground. */
  groundCents: 3,
  /** POST /v1/parse. */
  parseCents: 0,
  /** Surcharge per trajectory screenshot attached. */
  trajectoryImageCents: 2,
  /** Surcharge per HD image (width > 1280 OR height > 720, strictly). */
  hdImageCents: 1,
  /** Surcharge per request on the v1 engine. */
  v1EngineCents: 3,
  /** Surcharge when system_prompt exceeds 500 chars (exactly 500 is free). */
  longSystemPromptCents: 1,
  systemPromptFreeChars: 500,
  /** Run / workflow-task step on v3/v4. */
  runStepCentsV3: 5,
  /** Run / workflow-task step on v1 (5 base + 3 engine surcharge). */
  runStepCentsV1: 8,
  /** Machine runtime, cents per hour. */
  machineHourly: {
    linuxRunning: 5,
    windowsRunning: 9,
    stopped: 1,
  },
  /** One-time snapshot fee. */
  snapshotCents: 1,
  /** Minimum wallet balance to provision a machine / create schedules (a gate, not a fee). */
  provisioningGateCents: 20,
} as const;

/** HD per docs: width > 1280 OR height > 720, strictly (1280x720 exactly is NOT HD). */
export function isHdImage(width: number, height: number): boolean {
  return width > 1280 || height > 720;
}

export interface PredictCostInput {
  cuaVersion?: CuaVersion;
  /** Number of trajectory screenshots attached (beyond the current one). */
  trajectoryCount?: number;
  /** Whether the current screenshot is HD. */
  currentHd?: boolean;
  /** How many trajectory screenshots are HD. */
  trajectoryHdCount?: number;
  systemPromptChars?: number;
}

/** Cost of one stateless POST /v1/predict call. */
export function predictCallCents(input: PredictCostInput = {}): number {
  return inferenceCallCents(PRICING.predictBaseCents, input);
}

/** Cost of one POST /v1/sessions/{id}/predict step. */
export function sessionStepCents(input: PredictCostInput = {}): number {
  return inferenceCallCents(PRICING.sessionStepCents, input);
}

function inferenceCallCents(baseCents: number, input: PredictCostInput): number {
  const {
    cuaVersion = 'v3',
    trajectoryCount = 0,
    currentHd = false,
    trajectoryHdCount = 0,
    systemPromptChars = 0,
  } = input;
  let cents = baseCents;
  cents += trajectoryCount * PRICING.trajectoryImageCents;
  if (currentHd) cents += PRICING.hdImageCents;
  cents += trajectoryHdCount * PRICING.hdImageCents;
  if (cuaVersion === 'v1') cents += PRICING.v1EngineCents;
  if (systemPromptChars > PRICING.systemPromptFreeChars) cents += PRICING.longSystemPromptCents;
  return cents;
}

/** Cost of one ground call. */
export function groundCallCents(opts: { hd?: boolean } = {}): number {
  return PRICING.groundCents + (opts.hd ? PRICING.hdImageCents : 0);
}

/** Per-step cost of a server-side run (no surcharges apply to run steps). */
export function runStepCents(cuaVersion: CuaVersion = 'v3'): number {
  return cuaVersion === 'v1' ? PRICING.runStepCentsV1 : PRICING.runStepCentsV3;
}

export interface RunEstimate {
  perStepCents: number;
  /** A run bills at least one step. */
  minCents: number;
  /** Worst case: every allowed step executes. */
  maxCents: number;
}

/** Estimate a run's cost range from its step cap. */
export function runEstimateCents(opts: { cuaVersion?: CuaVersion; maxSteps?: number }): RunEstimate {
  const perStep = runStepCents(opts.cuaVersion ?? 'v3');
  const maxSteps = opts.maxSteps ?? 50;
  return { perStepCents: perStep, minCents: perStep, maxCents: perStep * maxSteps };
}

export interface WorkflowEstimate {
  /** Task steps on the typical path (loops×count, retries×1, both if-branches' max). */
  taskCount: number;
  typicalCents: number;
  /** Worst case: retries exhausted, while-loops at the assumed cap. */
  worstCaseCents: number;
}

export interface WorkflowEstimateOptions {
  cuaVersion?: CuaVersion;
  /** Agent steps a typical task takes. Default 4. */
  assumedStepsPerTask?: number;
  /** Iterations assumed for `while` loops without a better bound. Default 3. */
  assumedWhileIterations?: number;
}

/**
 * Estimate workflow cost by counting task steps through the DSL tree.
 * Control-flow steps are free per the docs; only `task` steps bill.
 */
export function workflowEstimateCents(
  definition: WorkflowDefinition,
  opts: WorkflowEstimateOptions = {},
): WorkflowEstimate {
  const { cuaVersion = 'v3', assumedStepsPerTask = 4, assumedWhileIterations = 3 } = opts;
  const perStep = runStepCents(cuaVersion);

  interface Counts {
    typicalTasks: number;
    worstTasks: number;
  }

  function countSteps(steps: WorkflowStep[]): Counts {
    let typicalTasks = 0;
    let worstTasks = 0;
    for (const step of steps) {
      const c = countStep(step);
      typicalTasks += c.typicalTasks;
      worstTasks += c.worstTasks;
    }
    return { typicalTasks, worstTasks };
  }

  function countStep(step: WorkflowStep): Counts {
    switch (step.type) {
      case 'task':
        return { typicalTasks: 1, worstTasks: 1 };
      case 'if': {
        const thenC = countSteps(step.then);
        const elseC = step.else ? countSteps(step.else) : { typicalTasks: 0, worstTasks: 0 };
        return {
          typicalTasks: Math.max(thenC.typicalTasks, elseC.typicalTasks),
          worstTasks: Math.max(thenC.worstTasks, elseC.worstTasks),
        };
      }
      case 'loop': {
        const body = countSteps(step.body);
        const typicalIters = step.count ?? Math.min(assumedWhileIterations, step.max_iterations ?? assumedWhileIterations);
        const worstIters = step.count ?? step.max_iterations ?? assumedWhileIterations;
        return {
          typicalTasks: body.typicalTasks * typicalIters,
          worstTasks: body.worstTasks * worstIters,
        };
      }
      case 'parallel': {
        let typicalTasks = 0;
        let worstTasks = 0;
        for (const branch of step.branches) {
          const c = countSteps(branch);
          typicalTasks += c.typicalTasks;
          worstTasks += c.worstTasks;
        }
        return { typicalTasks, worstTasks };
      }
      case 'retry': {
        const body = countSteps(step.body);
        return {
          typicalTasks: body.typicalTasks,
          worstTasks: body.worstTasks * step.max_attempts,
        };
      }
      case 'assert':
      case 'human_approval':
      case 'succeed':
      case 'fail':
        return { typicalTasks: 0, worstTasks: 0 };
    }
  }

  const counts = countSteps(definition.steps);
  return {
    taskCount: counts.typicalTasks,
    typicalCents: counts.typicalTasks * assumedStepsPerTask * perStep,
    worstCaseCents: counts.worstTasks * assumedStepsPerTask * perStep,
  };
}

/** Machine runtime rate, cents/hour, per documented table. */
export function machineRuntimeCentsPerHour(os: MachineOsType, state: 'running' | 'stopped' | 'terminated' | 'creating'): number {
  if (state === 'terminated' || state === 'creating') return 0;
  if (state === 'stopped') return PRICING.machineHourly.stopped;
  return os === 'windows' ? PRICING.machineHourly.windowsRunning : PRICING.machineHourly.linuxRunning;
}

/** Format integer cents as a dollar string: 5 → '$0.05', 123 → '$1.23'. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
