/**
 * Shared display helpers + the curated run-status vocabulary, co-located with
 * the tokens so web and React Native render identical labels and money strings
 * (the audit found the mobile `formatCents` mishandled negatives and mobile
 * showed raw `status.replace(/_/g,' ')` instead of curated labels).
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/** Status tone vocabulary (matches the UI Badge tones). */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';

export interface RunStatusMeta {
  tone: StatusTone;
  label: string;
}

/** Curated tone + human label per run status — the single source for both platforms. */
export const RUN_STATUS_META: Record<RunStatus, RunStatusMeta> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  awaiting_human: { tone: 'warning', label: 'Awaiting human' },
  succeeded: { tone: 'success', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  timed_out: { tone: 'danger', label: 'Timed out' },
};

/** Format USD cents as a dollar string: `20 -> "$0.20"`, `-5 -> "-$0.05"`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
