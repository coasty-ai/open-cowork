import type { ReactNode } from 'react';
import { cx } from '../cx';

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  /** Optional leading icon/illustration (rendered above the title, muted). */
  icon?: ReactNode;
  /** Short headline, e.g. "No runs yet". */
  title: string;
  /** Optional supporting copy. */
  description?: string;
  /** Optional call-to-action element (usually a Button). */
  action?: ReactNode;
  className?: string;
}

/** Friendly placeholder for empty lists and zero-data screens. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx('oc-empty-state', className)}>
      {icon ? (
        <span className="oc-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h3 className="oc-empty-state__title">{title}</h3>
      {description ? <p className="oc-empty-state__description">{description}</p> : null}
      {action ?? null}
    </div>
  );
}
