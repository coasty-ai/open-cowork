import { describe, expect, it } from 'vitest';
import { normalizeAction } from '@open-cowork/core';
import {
  coerceFromText,
  coerceModelStep,
  extractJson,
  mapModelStep,
  MODEL_STEP_SCHEMA,
  toCuaAction,
  type ModelAction,
} from '../src/actionParser';
import { LlmProviderError } from '../src/errors';

const click = (over: Partial<ModelAction> = {}): ModelAction => ({
  type: 'click',
  x: 10,
  y: 20,
  ...over,
});

describe('toCuaAction — every action type', () => {
  it('click → left single', () => {
    expect(toCuaAction(click())).toEqual({
      action_type: 'click',
      params: { x: 10, y: 20, button: 'left', clicks: 1 },
    });
  });
  it('double_click → 2 clicks', () => {
    expect(toCuaAction(click({ type: 'double_click' })).params).toMatchObject({ clicks: 2 });
  });
  it('right_click / middle_click → button', () => {
    expect(toCuaAction(click({ type: 'right_click' })).params).toMatchObject({ button: 'right' });
    expect(toCuaAction(click({ type: 'middle_click' })).params).toMatchObject({ button: 'middle' });
  });
  it('explicit button on click is honored', () => {
    expect(toCuaAction(click({ button: 'right' })).params).toMatchObject({ button: 'right' });
  });
  it('rounds fractional coordinates', () => {
    expect(toCuaAction(click({ x: 10.7, y: 20.2 })).params).toMatchObject({ x: 11, y: 20 });
  });
  it('type → type_text', () => {
    expect(toCuaAction({ type: 'type', text: 'hello' })).toEqual({
      action_type: 'type_text',
      params: { text: 'hello' },
    });
  });
  it('type with empty string is valid', () => {
    expect(toCuaAction({ type: 'type', text: '' }).params).toEqual({ text: '' });
  });
  it('key (array) and key (singular alias)', () => {
    expect(toCuaAction({ type: 'key', keys: ['enter'] })).toMatchObject({
      action_type: 'key_press',
      params: { keys: ['enter'] },
    });
    expect(toCuaAction({ type: 'key', key: 'tab' }).params).toEqual({ keys: ['tab'] });
  });
  it('hotkey → key_combo', () => {
    expect(toCuaAction({ type: 'hotkey', keys: ['ctrl', 'c'] })).toMatchObject({
      action_type: 'key_combo',
      params: { keys: ['ctrl', 'c'] },
    });
  });
  it('scroll defaults direction down + amount 3, abs amount', () => {
    expect(toCuaAction({ type: 'scroll' }).params).toMatchObject({ direction: 'down', amount: 3 });
    expect(toCuaAction({ type: 'scroll', direction: 'up', amount: -5 }).params).toMatchObject({
      direction: 'up',
      amount: 5,
    });
  });
  it('drag → from/to', () => {
    expect(toCuaAction({ type: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 })).toMatchObject({
      action_type: 'drag',
      params: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: 'left' },
    });
  });
  it('move → move', () => {
    expect(toCuaAction({ type: 'move', x: 5, y: 6 })).toEqual({
      action_type: 'move',
      params: { x: 5, y: 6 },
    });
  });
  it('wait ms / seconds / default', () => {
    expect(toCuaAction({ type: 'wait', ms: 500 }).params).toEqual({ ms: 500 });
    expect(toCuaAction({ type: 'wait', seconds: 2 }).params).toEqual({ ms: 2000 });
    expect(toCuaAction({ type: 'wait' }).params).toEqual({ ms: 1000 });
  });
  it('done / fail', () => {
    expect(toCuaAction({ type: 'done' })).toEqual({ action_type: 'done', params: {} });
    expect(toCuaAction({ type: 'fail', reason: 'blocked' })).toEqual({
      action_type: 'fail',
      params: { reason: 'blocked' },
    });
  });
});

describe('toCuaAction — invalid → BAD_OUTPUT (no silent no-op)', () => {
  it.each([
    ['click without coords', { type: 'click' } as ModelAction],
    ['click missing y', { type: 'click', x: 1 } as ModelAction],
    ['drag missing to_x', { type: 'drag', x: 1, y: 2, to_y: 4 } as ModelAction],
    ['move missing coords', { type: 'move' } as ModelAction],
    ['type missing text', { type: 'type' } as ModelAction],
    ['key with no keys', { type: 'key' } as ModelAction],
    ['hotkey with empty keys', { type: 'hotkey', keys: [] } as ModelAction],
    ['NaN coordinate', { type: 'click', x: NaN, y: 2 } as ModelAction],
  ])('%s throws BAD_OUTPUT', (_label, action) => {
    expect(() => toCuaAction(action)).toThrowError(LlmProviderError);
    try {
      toCuaAction(action);
    } catch (e) {
      expect((e as LlmProviderError).code).toBe('BAD_OUTPUT');
    }
  });
});

describe('mapped actions survive normalizeAction (downstream contract)', () => {
  it('all mapped actions normalize cleanly', () => {
    const actions: ModelAction[] = [
      click(),
      { type: 'type', text: 'x' },
      { type: 'key', keys: ['enter'] },
      { type: 'hotkey', keys: ['ctrl', 'a'] },
      { type: 'scroll', direction: 'down', amount: 2 },
      { type: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 },
      { type: 'move', x: 1, y: 1 },
      { type: 'wait', ms: 10 },
    ];
    for (const a of actions) expect(() => normalizeAction(toCuaAction(a))).not.toThrow();
  });
});

describe('MODEL_STEP_SCHEMA + coerceModelStep', () => {
  it('defaults status to continue and actions to []', () => {
    expect(coerceModelStep({})).toEqual({ reasoning: undefined, status: 'continue', actions: [] });
  });
  it('maps a full step', () => {
    const step = coerceModelStep({
      reasoning: 'open it',
      status: 'continue',
      actions: [click(), { type: 'done' }],
    });
    expect(step.status).toBe('continue');
    expect(step.actions).toHaveLength(2);
    expect(step.actions[1]).toEqual({ action_type: 'done', params: {} });
  });
  it('non-object input → BAD_OUTPUT', () => {
    expect(() => coerceModelStep('nope')).toThrowError(/action schema/);
    expect(() => coerceModelStep(42)).toThrowError(LlmProviderError);
  });
  it('invalid status enum → BAD_OUTPUT', () => {
    expect(() => coerceModelStep({ status: 'maybe' })).toThrowError(LlmProviderError);
  });
  it('mapModelStep matches schema parse', () => {
    const parsed = MODEL_STEP_SCHEMA.parse({ status: 'done', actions: [] });
    expect(mapModelStep(parsed)).toEqual({ reasoning: undefined, status: 'done', actions: [] });
  });
});

describe('extractJson — defensive recovery from text', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"status":"done","actions":[]}')).toEqual({ status: 'done', actions: [] });
  });
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"status":"continue","actions":[]}\n```')).toMatchObject({
      status: 'continue',
    });
  });
  it('strips plain ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('ignores prose around the object', () => {
    expect(
      extractJson('Sure! Here you go:\n{"status":"done","actions":[]}\nHope that helps'),
    ).toMatchObject({ status: 'done' });
  });
  it('handles nested braces and braces inside strings', () => {
    expect(
      extractJson('{"actions":[{"type":"type","text":"a {literal} brace }"}],"status":"continue"}'),
    ).toMatchObject({ status: 'continue' });
  });
  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"text":"he said \\"hi\\" }"}')).toEqual({ text: 'he said "hi" }' });
  });
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['no object', 'just some prose, no json here'],
    ['unterminated', '{"status":"continue"'],
    ['invalid json', '{status: continue}'],
  ])('%s → BAD_OUTPUT', (_label, text) => {
    expect(() => extractJson(text)).toThrowError(LlmProviderError);
  });
});

describe('coerceFromText (extract + coerce)', () => {
  it('recovers a fenced step from a chatty model', () => {
    const step = coerceFromText(
      'I will click the button.\n```json\n{"status":"continue","actions":[{"type":"click","x":3,"y":4}]}\n```',
    );
    expect(step.actions[0]).toMatchObject({ action_type: 'click', params: { x: 3, y: 4 } });
  });
  it('text with a structurally-valid-but-action-invalid step → BAD_OUTPUT', () => {
    expect(() => coerceFromText('{"status":"continue","actions":[{"type":"click"}]}')).toThrowError(
      LlmProviderError,
    );
  });
});
