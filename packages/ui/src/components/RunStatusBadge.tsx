import { cx } from '../cx';
import { Badge } from './Badge';
import { RUN_STATUS_META, type RunStatus } from '@open-cowork/tokens';

/**
 * Run lifecycle states + their curated tone/label come from the shared
 * `@open-cowork/tokens` source, so web/desktop and React Native render an
 * identical status vocabulary (mobile's StatusChip consumes the same map).
 */
export type { RunStatus };

/** Props for {@link RunStatusBadge}. */
export interface RunStatusBadgeProps {
  /** Current run status. */
  status: RunStatus;
  className?: string;
}

/**
 * Status pill for a run. Each status maps to a tone + human label; the
 * `running` state additionally shows an animated pulse dot.
 */
export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const meta = RUN_STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={cx('oc-run-status', `oc-run-status--${status}`, className)}>
      {status === 'running' ? (
        <span className="oc-run-status__pulse" data-testid="run-status-pulse" aria-hidden="true" />
      ) : null}
      {meta.label}
    </Badge>
  );
}
