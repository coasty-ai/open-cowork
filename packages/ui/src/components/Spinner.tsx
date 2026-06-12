import { cx } from '../cx';

/** Props for {@link Spinner}. */
export interface SpinnerProps {
  /** Visual size. `sm` fits inline inside buttons; `md` is standalone. */
  size?: 'sm' | 'md';
  /** Accessible label announced to screen readers. Defaults to "Loading". */
  label?: string;
  className?: string;
}

/**
 * Indeterminate loading indicator with `role="status"` and an accessible
 * label, so assistive tech announces in-progress work.
 */
export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx('oc-spinner', size === 'sm' && 'oc-spinner--sm', className)}
    />
  );
}
