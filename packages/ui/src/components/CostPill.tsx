import { cx } from '../cx';

/** Props for {@link CostPill}. */
export interface CostPillProps {
  /** Amount in USD cents (1 Coasty credit = 1 cent = $0.01). */
  cents: number;
  /** Whether this is a pre-flight estimate or an actual billed amount. */
  variant: 'estimate' | 'actual';
  className?: string;
}

/**
 * Formats USD cents as a dollar string, e.g. `20 -> "$0.20"`, `-5 -> "-$0.05"`.
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * Cost pill rendering `$X.YZ` with an accessible label such as
 * "estimated cost $0.20" or "actual cost $0.20".
 */
export function CostPill({ cents, variant, className }: CostPillProps) {
  const amount = formatCents(cents);
  const label = `${variant === 'estimate' ? 'estimated' : 'actual'} cost ${amount}`;
  return (
    <span
      className={cx('oc-cost-pill', `oc-cost-pill--${variant}`, className)}
      aria-label={label}
    >
      <span aria-hidden="true">{amount}</span>
    </span>
  );
}
