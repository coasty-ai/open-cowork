import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventTimeline } from '../src/index';
import type { TimelineEvent } from '../src/index';

const events: TimelineEvent[] = [
  { seq: 1, type: 'status', label: 'Run started', at: '2026-06-11T12:00:00Z' },
  { seq: 2, type: 'tool_call', label: 'Clicked Login', detail: '{"x":512,"y":340}' },
  { seq: 3, type: 'step', label: 'Step 1 completed' },
];

describe('EventTimeline', () => {
  it('renders a log of events in order', () => {
    render(<EventTimeline events={events} />);
    const log = screen.getByRole('log');
    const items = log.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Run started');
    expect(items[2]).toHaveTextContent('Step 1 completed');
  });

  it('shows a per-type glyph (and a fallback for unknown types)', () => {
    render(
      <EventTimeline
        events={[
          { seq: 1, type: 'done', label: 'Finished' },
          { seq: 2, type: 'mystery', label: 'Odd one' },
        ]}
      />,
    );
    const log = screen.getByRole('log');
    const glyphs = Array.from(log.querySelectorAll('.oc-timeline__glyph')).map(
      (node) => node.textContent,
    );
    expect(glyphs).toEqual(['✓', '•']);
  });

  it('renders detail inside a collapsible <details>', async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={events} />);
    const summary = screen.getByText('Detail');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('{"x":512,"y":340}')).toBeInTheDocument();
  });

  it('renders a timestamp when provided', () => {
    render(<EventTimeline events={events} />);
    const time = screen.getByText('2026-06-11T12:00:00Z');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-06-11T12:00:00Z');
  });

  it('appends newly arrived events on rerender', () => {
    const { rerender } = render(<EventTimeline events={events} />);
    expect(screen.getByRole('log').querySelectorAll('li')).toHaveLength(3);
    rerender(
      <EventTimeline events={[...events, { seq: 4, type: 'done', label: 'Run succeeded' }]} />,
    );
    const items = screen.getByRole('log').querySelectorAll('li');
    expect(items).toHaveLength(4);
    expect(items[3]).toHaveTextContent('Run succeeded');
  });

  it('shows an empty state when there are no events', () => {
    render(<EventTimeline events={[]} />);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No events yet' })).toBeInTheDocument();
  });

  it('shows a spinner while loading', () => {
    render(<EventTimeline events={[]} loading />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading events');
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });
});
