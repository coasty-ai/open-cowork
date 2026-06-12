import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletCard } from '../src/index';

describe('WalletCard', () => {
  it('renders balance and monthly spend in dollars', () => {
    render(<WalletCard balanceCents={9300} spentThisMonthCents={540} />);
    expect(screen.getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('$93.00')).toBeInTheDocument();
    expect(screen.getByText('Spent this month')).toBeInTheDocument();
    expect(screen.getByText('$5.40')).toBeInTheDocument();
  });

  it('renders em dashes for missing amounts', () => {
    render(<WalletCard />);
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('shows a spinner while loading', () => {
    render(<WalletCard loading />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading wallet');
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
  });

  it('shows a retryable error state', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<WalletCard error="Could not load wallet" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load wallet');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
