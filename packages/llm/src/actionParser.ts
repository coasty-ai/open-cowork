/**
 * Translate a BYO model's structured step into the exact `CuaAction[]` the agent
 * loop + executors already consume. The model speaks a flat, LLM-friendly action
 * vocabulary (`MODEL_STEP_SCHEMA`); we map it to Coasty's `CuaAction` shape and
 * reuse the existing `normalizeAction` downstream — so nothing else in the app
 * changes. Defensive throughout: malformed output raises `BAD_OUTPUT` (never a
 * silent no-op), and a text fallback (`coerceFromText`) recovers JSON from
 * weaker models that can't emit a clean object.
 */
import { z } from 'zod';
import type { CuaAction, PredictStatus } from '@open-cowork/core';
import { LlmProviderError } from './errors';

/** A single action in the model-facing vocabulary (forgiving aliases included). */
const ModelActionSchema = z.object({
  type: z.enum([
    'click',
    'double_click',
    'right_click',
    'middle_click',
    'type',
    'key',
    'hotkey',
    'scroll',
    'drag',
    'move',
    'wait',
    'done',
    'fail',
  ]),
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().optional(),
  keys: z.array(z.string()).optional(),
  key: z.string().optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().optional(),
  to_x: z.number().optional(),
  to_y: z.number().optional(),
  ms: z.number().optional(),
  seconds: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  reason: z.string().optional(),
});

export type ModelAction = z.infer<typeof ModelActionSchema>;

/** The full per-step object the model returns (used by `generateObject`). */
export const MODEL_STEP_SCHEMA = z.object({
  reasoning: z.string().optional(),
  status: z.enum(['continue', 'done', 'fail']).default('continue'),
  actions: z.array(ModelActionSchema).default([]),
});

export type ModelStep = z.infer<typeof MODEL_STEP_SCHEMA>;

export interface ParsedStep {
  reasoning?: string;
  status: PredictStatus;
  actions: CuaAction[];
}

function need(value: number | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LlmProviderError('BAD_OUTPUT', `Model action is missing a numeric ${what}.`);
  }
  return Math.round(value);
}

/** A finite, non-negative duration/amount (NaN/Infinity/negative → BAD_OUTPUT). */
function nonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new LlmProviderError('BAD_OUTPUT', `Model action has an invalid ${what}.`);
  }
  return Math.round(value);
}

/** Map one model action to a Coasty `CuaAction`. Throws BAD_OUTPUT if invalid. */
export function toCuaAction(a: ModelAction): CuaAction {
  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click': {
      const button =
        a.type === 'right_click'
          ? 'right'
          : a.type === 'middle_click'
            ? 'middle'
            : (a.button ?? 'left');
      const clicks = a.type === 'double_click' ? 2 : 1;
      return {
        action_type: 'click',
        params: { x: need(a.x, 'x'), y: need(a.y, 'y'), button, clicks },
      };
    }
    case 'type':
      if (typeof a.text !== 'string') {
        throw new LlmProviderError('BAD_OUTPUT', 'type action is missing `text`.');
      }
      return { action_type: 'type_text', params: { text: a.text } };
    case 'key': {
      const keys = a.keys ?? (a.key ? [a.key] : []);
      if (keys.length === 0) throw new LlmProviderError('BAD_OUTPUT', 'key action has no keys.');
      return { action_type: 'key_press', params: { keys } };
    }
    case 'hotkey': {
      const keys = a.keys ?? (a.key ? [a.key] : []);
      if (keys.length === 0) throw new LlmProviderError('BAD_OUTPUT', 'hotkey action has no keys.');
      return { action_type: 'key_combo', params: { keys } };
    }
    case 'scroll': {
      // Distance defaults to 3 "clicks"; a sign just indicates direction, so we
      // take the magnitude. A non-finite amount/coordinate is malformed output.
      const amount = a.amount !== undefined ? nonNegative(Math.abs(a.amount), 'scroll amount') : 3;
      return {
        action_type: 'scroll',
        params: {
          x: a.x !== undefined ? need(a.x, 'scroll x') : undefined,
          y: a.y !== undefined ? need(a.y, 'scroll y') : undefined,
          direction: a.direction ?? 'down',
          amount,
        },
      };
    }
    case 'drag':
      return {
        action_type: 'drag',
        params: {
          from_x: need(a.x, 'x'),
          from_y: need(a.y, 'y'),
          to_x: need(a.to_x, 'to_x'),
          to_y: need(a.to_y, 'to_y'),
          button: a.button ?? 'left',
        },
      };
    case 'move':
      return { action_type: 'move', params: { x: need(a.x, 'x'), y: need(a.y, 'y') } };
    case 'wait': {
      const raw = a.ms ?? (a.seconds !== undefined ? a.seconds * 1000 : 1000);
      return { action_type: 'wait', params: { ms: nonNegative(raw, 'wait duration') } };
    }
    case 'done':
      return { action_type: 'done', params: {} };
    case 'fail':
      return { action_type: 'fail', params: { reason: a.reason } };
  }
}

/** Map a validated {@link ModelStep} to a {@link ParsedStep}. */
export function mapModelStep(step: ModelStep): ParsedStep {
  return {
    reasoning: step.reasoning,
    status: step.status,
    actions: step.actions.map(toCuaAction),
  };
}

/**
 * Coax an arbitrary parsed JSON value into the `{ status, actions }` step shape
 * before schema validation, so the harness tolerates the shapes weaker models
 * actually emit:
 *   - a bare actions array:            `[{type:'click',…}]`        → `{actions:[…]}`
 *   - a single bare action object:     `{type:'click',x,y}`        → `{actions:[…]}`
 *   - a one-key wrapper:               `{action:{…}}` / `{step:{…}}`→ unwrap
 * Anything already step-shaped (`status`/`actions` present) is returned as-is.
 */
export function normalizeStepShape(raw: unknown): unknown {
  if (Array.isArray(raw)) return { actions: raw };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if ('actions' in o || 'status' in o) return o;
    if (typeof o.type === 'string') return { actions: [o] }; // a single bare action
    if (o.action && typeof o.action === 'object') return normalizeStepShape(o.action);
    if (o.step && typeof o.step === 'object') return normalizeStepShape(o.step);
  }
  return raw;
}

/** Validate raw (unknown) model output and map it. Throws BAD_OUTPUT on failure. */
export function coerceModelStep(raw: unknown): ParsedStep {
  const parsed = MODEL_STEP_SCHEMA.safeParse(normalizeStepShape(raw));
  if (!parsed.success) {
    throw new LlmProviderError('BAD_OUTPUT', 'The model response did not match the action schema.');
  }
  return mapModelStep(parsed.data);
}

/** Index of the next `{` or `[` at or after `from`, or -1. */
function nextOpener(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') return i;
  }
  return -1;
}

/**
 * Index of the char that balances the bracket opened at `start` (counting BOTH
 * `{}` and `[]` on one depth, respecting strings/escapes), or -1 if unbalanced.
 * Counting both means a region like `[{…},{…}]` or `{"a":[…]}` closes correctly.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Recover a JSON value from a free-text model response: strips ``` fences and
 * prose, then returns the FIRST balanced region (object `{…}` or top-level array
 * `[…]`) that actually parses — skipping past stray/non-JSON brackets. The
 * fallback path for models that wrap output in chatter, reasoning, or markdown.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new LlmProviderError('BAD_OUTPUT', 'The model returned an empty response.');
  }
  // Drop code fences (```json … ``` or ``` … ```).
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1');
  let foundOpener = false;
  for (let p = nextOpener(unfenced, 0); p !== -1; p = nextOpener(unfenced, p + 1)) {
    foundOpener = true;
    const end = balancedEnd(unfenced, p);
    if (end !== -1) {
      try {
        return JSON.parse(unfenced.slice(p, end + 1));
      } catch {
        // Not JSON at this opener — keep scanning for the next candidate region.
      }
    }
  }
  if (foundOpener) {
    throw new LlmProviderError('BAD_OUTPUT', 'The model response was not valid JSON.');
  }
  throw new LlmProviderError('BAD_OUTPUT', 'No JSON object found in the model response.');
}

/** Recover + coerce a step from a free-text response. Throws BAD_OUTPUT on failure. */
export function coerceFromText(text: string): ParsedStep {
  return coerceModelStep(extractJson(text));
}
