import { cx } from '../cx';
import { Badge } from './Badge';
import type { BadgeTone } from './Badge';

/**
 * Run lifecycle states, mirroring the Coasty run state machine
 * (`queued -> running <-> awaiting_human -> terminal`).
 *
 * Defined locally so this package stays independent of `@open-cowork/core`;
 * apps map core's run status union into this identical type.
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

const RUN_STATUS_META: Record<RunStatus, { tone: BadgeTone; label: string }> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  awaiting_human: { tone: 'warning', label: 'Awaiting human' },
  succeeded: { tone: 'success', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  timed_out: { tone: 'danger', label: 'Timed out' },
};

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
