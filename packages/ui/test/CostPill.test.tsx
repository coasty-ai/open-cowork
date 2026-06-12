import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostPill, formatCents } from '../src/index';

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [20, '$0.20'],
    [123, '$1.23'],
    [12345, '$123.45'],
    [-5, '-$0.05'],
  ])('formats %d cents as %s', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });
});

describe('CostPill', () => {
  it('renders the formatted dollar amount', () => {
    render(<CostPill cents={20} variant="estimate" />);
    expect(screen.getByText('$0.20')).toBeInTheDocument();
  });

  it('labels estimates as "estimated cost $X.YZ"', () => {
    render(<CostPill cents={20} variant="estimate" />);
    expect(screen.getByLabelText('estimated cost $0.20')).toHaveClass('oc-cost-pill--estimate');
  });

  it('labels actuals as "actual cost $X.YZ"', () => {
    render(<CostPill cents={540} variant="actual" />);
    expect(screen.getByLabelText('actual cost $5.40')).toHaveClass('oc-cost-pill--actual');
  });
});
