import { cx } from '../cx';
import { Card } from './Card';
import { formatCents } from './CostPill';
import { ErrorState } from './ErrorState';
import { Spinner } from './Spinner';

/** Props for {@link WalletCard}. */
export interface WalletCardProps {
  /** Prepaid wallet balance in USD cents (Coasty `wallet_balance_cents`). */
  balanceCents?: number;
  /** Spend this billing period in USD cents (Coasty `total_cost_cents`). */
  spentThisMonthCents?: number;
  /** Shows a spinner instead of the stats. */
  loading?: boolean;
  /** Error message; renders an {@link ErrorState} instead of the stats. */
  error?: string;
  /** Retry handler forwarded to the error state. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Wallet summary card: prepaid balance and month-to-date spend, with
 * loading and error (retryable) states.
 */
export function WalletCard({
  balanceCents,
  spentThisMonthCents,
  loading = false,
  error,
  onRetry,
  className,
}: WalletCardProps) {
  return (
    <Card title="Wallet" className={cx('oc-wallet-card', className)}>
      {loading ? (
        <Spinner label="Loading wallet" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : (
        <dl className="oc-wallet-card__stats">
          <div>
            <dt>Balance</dt>
            <dd>{balanceCents !== undefined ? formatCents(balanceCents) : '—'}</dd>
          </div>
          <div>
            <dt>Spent this month</dt>
            <dd>{spentThisMonthCents !== undefined ? formatCents(spentThisMonthCents) : '—'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
