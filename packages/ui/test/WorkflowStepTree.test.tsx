import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowStepTree } from '../src/index';
import type { WorkflowStep } from '../src/index';

const steps: WorkflowStep[] = [
  { id: 'fetch', type: 'task', label: 'Fetch invoice', status: 'succeeded' },
  {
    id: 'branch',
    type: 'if',
    label: 'Paid?',
    status: 'running',
    children: [
      { id: 'ok', type: 'succeed', label: 'Mark paid', status: 'pending' },
      { id: 'no', type: 'fail', label: 'Flag unpaid', status: 'skipped' },
    ],
  },
];

describe('WorkflowStepTree', () => {
  it('renders a tree with nested groups and treeitems', () => {
    render(<WorkflowStepTree steps={steps} />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(4);
    expect(screen.getByRole('group')).toBeInTheDocument();
    expect(screen.getByText('Fetch invoice')).toBeInTheDocument();
    expect(screen.getByText('Mark paid')).toBeInTheDocument();
  });

  it('falls back to the step id when no label is given', () => {
    render(<WorkflowStepTree steps={[{ id: 'step-1', type: 'task' }]} />);
    expect(screen.getByText('step-1')).toBeInTheDocument();
  });

  it('shows a status dot per step (default pending)', () => {
    render(<WorkflowStepTree steps={steps} />);
    expect(screen.getByTestId('step-dot-fetch')).toHaveClass('oc-step-tree__dot--succeeded');
    expect(screen.getByTestId('step-dot-branch')).toHaveClass('oc-step-tree__dot--running');
    expect(screen.getByTestId('step-dot-ok')).toHaveClass('oc-step-tree__dot--pending');
    expect(screen.getByTestId('step-dot-no')).toHaveClass('oc-step-tree__dot--skipped');
  });

  it('only container nodes get a toggle button with aria-expanded', () => {
    render(<WorkflowStepTree steps={steps} />);
    const toggles = screen.getAllByRole('button');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[0]).toHaveAccessibleName('Collapse Paid?');
  });

  it('collapses and re-expands children via the toggle', async () => {
    const user = userEvent.setup();
    render(<WorkflowStepTree steps={steps} />);

    await user.click(screen.getByRole('button', { name: 'Collapse Paid?' }));
    expect(screen.queryByText('Mark paid')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Expand Paid?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByText('Mark paid')).toBeInTheDocument();
  });
});
