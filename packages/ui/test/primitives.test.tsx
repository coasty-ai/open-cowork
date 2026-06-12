import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Badge, Card, EmptyState, ErrorState, OfflineBanner, Spinner } from '../src/index';

describe('Card', () => {
  it('renders a title heading and children', () => {
    render(
      <Card title="Wallet">
        <p>Body copy</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
    expect(screen.getByText('Body copy')).toBeInTheDocument();
  });

  it('omits the heading when no title is given', () => {
    render(<Card>plain</Card>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders neutral by default', () => {
    render(<Badge>3 runs</Badge>);
    const badge = screen.getByText('3 runs');
    expect(badge).toHaveClass('oc-badge');
    expect(badge.className).not.toContain('oc-badge--');
  });

  it.each(['success', 'warning', 'danger', 'info'] as const)('applies the %s tone', (tone) => {
    render(<Badge tone={tone}>T</Badge>);
    expect(screen.getByText('T')).toHaveClass(`oc-badge--${tone}`);
  });
});

describe('Spinner', () => {
  it('exposes role="status" with a default aria-label', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading');
  });

  it('accepts a custom label and small size', () => {
    render(<Spinner size="sm" label="Loading wallet" />);
    const spinner = screen.getByRole('status');
    expect(spinner).toHaveAccessibleName('Loading wallet');
    expect(spinner).toHaveClass('oc-spinner--sm');
  });
});

describe('EmptyState', () => {
  it('renders title, description, and action', () => {
    render(
      <EmptyState
        title="No runs yet"
        description="Delegate a task to get started."
        action={<button type="button">New run</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No runs yet' })).toBeInTheDocument();
    expect(screen.getByText('Delegate a task to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument();
  });

  it('renders without optional parts', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders an alert with the message', () => {
    render(<ErrorState message="Something broke" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders a Retry button wired to onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Boom" onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    render(<OfflineBanner offline={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders a status banner while offline', () => {
    render(<OfflineBanner offline />);
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
  });

  it('accepts a custom message', () => {
    render(<OfflineBanner offline message="No connection" />);
    expect(screen.getByRole('status')).toHaveTextContent('No connection');
  });
});
