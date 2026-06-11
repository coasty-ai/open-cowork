import { describe, expect, it } from 'vitest';
import { normalizeAction, type CuaAction } from '../src/index';

describe('normalizeAction', () => {
  it('click: applies defaults', () => {
    const a: CuaAction = { action_type: 'click', params: { x: 10, y: 20 } };
    expect(normalizeAction(a)).toEqual({ action_type: 'click', x: 10, y: 20, button: 'left', clicks: 1 });
  });

  it('click: preserves explicit button/clicks', () => {
    const a: CuaAction = { action_type: 'click', params: { x: 1, y: 2, button: 'right', clicks: 2 } };
    expect(normalizeAction(a)).toMatchObject({ button: 'right', clicks: 2 });
  });

  it('type_text passes text through', () => {
    expect(normalizeAction({ action_type: 'type_text', params: { text: 'hi' } })).toEqual({
      action_type: 'type_text',
      text: 'hi',
    });
  });

  it('key_press: reference shape {key}', () => {
    expect(normalizeAction({ action_type: 'key_press', params: { key: 'enter' } })).toEqual({
      action_type: 'key_press',
      keys: ['enter'],
    });
  });

  it('key_press: example shape {keys: array}', () => {
    expect(normalizeAction({ action_type: 'key_press', params: { keys: ['tab', 'enter'] } })).toEqual({
      action_type: 'key_press',
      keys: ['tab', 'enter'],
    });
  });

  it('key_press: {keys: string} variant', () => {
    expect(normalizeAction({ action_type: 'key_press', params: { keys: 'esc' } })).toEqual({
      action_type: 'key_press',
      keys: ['esc'],
    });
  });

  it('key_combo keeps chord order', () => {
    expect(normalizeAction({ action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } })).toEqual({
      action_type: 'key_combo',
      keys: ['ctrl', 'c'],
    });
  });

  it('scroll: reference shape {direction, amount}', () => {
    expect(
      normalizeAction({ action_type: 'scroll', params: { x: 5, y: 6, direction: 'up', amount: 4 } }),
    ).toEqual({ action_type: 'scroll', x: 5, y: 6, direction: 'up', amount: 4 });
  });

  it('scroll: pyautogui {clicks} positive → up', () => {
    expect(normalizeAction({ action_type: 'scroll', params: { clicks: 3 } })).toMatchObject({
      direction: 'up',
      amount: 3,
    });
  });

  it('scroll: pyautogui {clicks} negative → down', () => {
    expect(normalizeAction({ action_type: 'scroll', params: { clicks: -7 } })).toMatchObject({
      direction: 'down',
      amount: 7,
    });
  });

  it('drag: reference shape from_x...', () => {
    expect(
      normalizeAction({ action_type: 'drag', params: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 } }),
    ).toEqual({ action_type: 'drag', from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: 'left' });
  });

  it('drag: example shape x1/y1/x2/y2', () => {
    expect(normalizeAction({ action_type: 'drag', params: { x1: 9, y1: 8, x2: 7, y2: 6 } })).toMatchObject({
      from_x: 9,
      from_y: 8,
      to_x: 7,
      to_y: 6,
    });
  });

  it('drag: missing coordinates throws loudly', () => {
    expect(() => normalizeAction({ action_type: 'drag', params: { from_x: 1 } })).toThrow(/coordinates/);
  });

  it('wait: reference shape {ms}', () => {
    expect(normalizeAction({ action_type: 'wait', params: { ms: 250 } })).toEqual({ action_type: 'wait', ms: 250 });
  });

  it('wait: example shape {seconds}', () => {
    expect(normalizeAction({ action_type: 'wait', params: { seconds: 2 } })).toEqual({ action_type: 'wait', ms: 2000 });
  });

  it('wait: defaults to 1000ms when neither given', () => {
    expect(normalizeAction({ action_type: 'wait', params: {} })).toEqual({ action_type: 'wait', ms: 1000 });
  });

  it('done / fail / raw / move', () => {
    expect(normalizeAction({ action_type: 'done', params: {} })).toEqual({ action_type: 'done' });
    expect(normalizeAction({ action_type: 'fail', params: { reason: 'blocked' } })).toEqual({
      action_type: 'fail',
      reason: 'blocked',
    });
    expect(normalizeAction({ action_type: 'raw', params: { code: 'pyautogui.click(1,2)' } })).toEqual({
      action_type: 'raw',
      code: 'pyautogui.click(1,2)',
    });
    expect(normalizeAction({ action_type: 'move', params: { x: 3, y: 4 } })).toEqual({
      action_type: 'move',
      x: 3,
      y: 4,
    });
  });

  it('unknown action type throws', () => {
    expect(() => normalizeAction({ action_type: 'teleport', params: {} } as unknown as CuaAction)).toThrow(
      /Unknown action_type/,
    );
  });
});
