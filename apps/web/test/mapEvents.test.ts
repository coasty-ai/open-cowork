import { describe, expect, it } from 'vitest';
import { eventToTimeline } from '../src/mapEvents';

describe('eventToTimeline', () => {
  it.each([
    [{ seq: 1, type: 'status', data: { status: 'running' } }, 'Status → running'],
    [{ seq: 2, type: 'step', data: { steps_completed: 3 } }, 'Step 3 completed'],
    [{ seq: 3, type: 'billing', data: { cost_cents: 25 } }, 'Spend so far: $0.25'],
    [
      { seq: 4, type: 'awaiting_human', data: { reason: 'captcha' } },
      '⏸ Waiting for a human — captcha',
    ],
    [{ seq: 5, type: 'resumed', data: {} }, '▶ Resumed by a human'],
    [{ seq: 6, type: 'done', data: { status: 'succeeded' } }, 'Finished: succeeded'],
    [{ seq: 7, type: 'text', data: { text: 'Opening the menu' } }, 'Opening the menu'],
    [{ seq: 8, type: 'error', data: { message: 'boom' } }, 'Error: boom'],
  ])('maps %j', (event, expectedLabel) => {
    const mapped = eventToTimeline(event);
    expect(mapped.label).toBe(expectedLabel);
    expect(mapped.seq).toBe(event.seq);
    expect(mapped.type).toBe(event.type);
  });

  it('tool_call carries a JSON detail payload', () => {
    const mapped = eventToTimeline({ seq: 9, type: 'tool_call', data: { tool: 'click', x: 1 } });
    expect(mapped.label).toBe('Action: click');
    expect(mapped.detail).toContain('"x": 1');
  });

  it('unknown types fall back to the raw type + JSON detail', () => {
    const mapped = eventToTimeline({ seq: 10, type: 'mystery', data: { a: 1 } });
    expect(mapped.label).toBe('mystery');
    expect(mapped.detail).toContain('"a": 1');
  });

  it('billing prefers cost_cents but accepts spent_cents (workflow runs)', () => {
    expect(eventToTimeline({ seq: 11, type: 'billing', data: { spent_cents: 150 } }).label).toBe(
      'Spend so far: $1.50',
    );
  });
});
