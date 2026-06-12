import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStatusBadge } from '../src/index';
import type { RunStatus } from '../src/index';

const cases: Array<[RunStatus, string, string]> = [
  ['queued', 'Queued', 'oc-badge'],
  ['running', 'Running', 'oc-badge--info'],
  ['awaiting_human', 'Awaiting human', 'oc-badge--warning'],
  ['succeeded', 'Succeeded', 'oc-badge--success'],
  ['failed', 'Failed', 'oc-badge--danger'],
  ['cancelled', 'Cancelled', 'oc-badge'],
  ['timed_out', 'Timed out', 'oc-badge--danger'],
];

describe('RunStatusBadge', () => {
  it.each(cases)('renders %s as "%s" with tone class %s', (status, label, toneClass) => {
    render(<RunStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveClass(toneClass);
    expect(badge).toHaveClass(`oc-run-status--${status}`);
  });

  it('shows a pulse dot only while running', () => {
    const { rerender } = render(<RunStatusBadge status="running" />);
    expect(screen.getByTestId('run-status-pulse')).toBeInTheDocument();
    rerender(<RunStatusBadge status="succeeded" />);
    expect(screen.queryByTestId('run-status-pulse')).not.toBeInTheDocument();
  });
});
