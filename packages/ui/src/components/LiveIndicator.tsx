import { cx } from '../cx';

/** Props for {@link LiveIndicator}. */
export interface LiveIndicatorProps {
  /** Text after the pulsing dot. Default `Live`. */
  label?: string;
  className?: string;
}

/**
 * A small pulsing dot + label marking a live/streaming surface (e.g. an open
 * SSE timeline). Shares the monochrome status palette — the dot is the success
 * tone (a healthy, connected stream); the pulse honours reduced-motion.
 */
export function LiveIndicator({ label = 'Live', className }: LiveIndicatorProps) {
  return (
    <span className={cx('oc-live', className)} role="status">
      <span className="oc-live__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
