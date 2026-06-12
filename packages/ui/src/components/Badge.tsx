import type { ReactNode } from 'react';
import { cx } from '../cx';

/** Semantic tone of a {@link Badge}. */
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Props for {@link Badge}. */
export interface BadgeProps {
  /** Semantic tone. Defaults to `neutral`. */
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** Optional explicit accessible name (e.g. for icon-only badges). */
  'aria-label'?: string;
}

/** Small status pill used for run states, machine states, and counts. */
export function Badge({ tone = 'neutral', children, className, ...rest }: BadgeProps) {
  return (
    <span className={cx('oc-badge', tone !== 'neutral' && `oc-badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}
