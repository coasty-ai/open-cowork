import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunChat } from '../src/index';
import type { TimelineEvent } from '../src/index';

const events: TimelineEvent[] = [
  { seq: 1, type: 'status', label: 'Status → running' },
  { seq: 2, type: 'text', label: 'Opening the vendor portal.' },
  { seq: 3, type: 'reasoning', label: 'Model reasoning', detail: 'thinking through the options' },
  { seq: 4, type: 'tool_call', label: 'Action: click', detail: '{"x":512,"y":340}' },
  { seq: 5, type: 'step', label: 'Step 2 completed' },
  { seq: 6, type: 'billing', label: 'Spend so far: $0.40' },
  { seq: 7, type: 'screenshot', label: 'Screenshot captured' },
];

describe('RunChat', () => {
  it('renders the task as the opening user message', () => {
    render(<RunChat task="Reconcile the invoices" events={[]} />);
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Reconcile the invoices')).toBeInTheDocument();
  });

  it('exposes the agent activity as a role=log live region', () => {
    render(<RunChat task="t" events={events} />);
    const log = screen.getByRole('log');
    // Narration is plain prose; lifecycle events survive as markers.
    expect(within(log).getByText('Opening the vendor portal.')).toBeInTheDocument();
    expect(within(log).getByText('Status → running')).toBeInTheDocument();
    expect(within(log).getByText('Step 2 completed')).toBeInTheDocument();
    expect(within(log).getByText('Spend so far: $0.40')).toBeInTheDocument();
  });

  it('tucks reasoning and raw action payloads behind disclosures', () => {
    render(<RunChat task="t" events={events} />);
    const log = screen.getByRole('log');
    // The action label shows; its JSON payload lives inside a <details>.
    expect(within(log).getByText('Action: click')).toBeInTheDocument();
    const details = log.querySelectorAll('details');
    expect(details.length).toBe(2); // reasoning + action
    expect(log.querySelector('details pre')?.textContent).toContain('thinking through the options');
  });

  it('hides screenshot events — the live screen card stands in for them', () => {
    render(<RunChat task="t" events={events} />);
    expect(screen.queryByText('Screenshot captured')).not.toBeInTheDocument();
  });

  it('shows a starting line while working with no activity yet', () => {
    render(<RunChat task="t" events={[]} working workingLabel="Starting…" />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('renders injected children (live screen / summary) after the log', () => {
    render(
      <RunChat task="t" events={events}>
        <div data-testid="tail">final screen</div>
      </RunChat>,
    );
    expect(screen.getByTestId('tail')).toBeInTheDocument();
  });
});
