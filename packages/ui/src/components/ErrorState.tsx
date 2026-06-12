import { cx } from '../cx';
import { Button } from './Button';

/** Props for {@link ErrorState}. */
export interface ErrorStateProps {
  /** Human-readable error message. */
  message: string;
  /** When provided, renders a Retry button that invokes it. */
  onRetry?: () => void;
  className?: string;
}

/** Inline error panel (`role="alert"`) with an optional Retry action. */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cx('oc-error-state', className)}>
      <p className="oc-error-state__message">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
