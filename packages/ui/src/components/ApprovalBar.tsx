import { useId, useState } from 'react';
import { cx } from '../cx';
import { Button } from './Button';

/** Props for {@link ApprovalBar}. */
export interface ApprovalBarProps {
  /** Why the run paused (the run's `awaiting_human_reason`). */
  reason?: string;
  /** True while the approve/reject request is in flight; disables inputs. */
  pending?: boolean;
  /** Called with the note text when the user approves. */
  onApprove: (note: string) => void;
  /** Called with the note text when the user rejects. */
  onReject: (note: string) => void;
  className?: string;
}

/**
 * Human-takeover approval bar for `awaiting_human` runs: shows the pause
 * reason, collects an optional note, and offers Approve / Reject actions.
 * The note is passed through to the run/workflow resume endpoint.
 */
export function ApprovalBar({
  reason,
  pending = false,
  onApprove,
  onReject,
  className,
}: ApprovalBarProps) {
  const [note, setNote] = useState('');
  const noteId = useId();

  return (
    <div className={cx('oc-approval-bar', className)}>
      {reason ? <p className="oc-approval-bar__reason">{reason}</p> : null}
      <label className="oc-approval-bar__label" htmlFor={noteId}>
        Note
      </label>
      <textarea
        id={noteId}
        className="oc-approval-bar__note"
        value={note}
        disabled={pending}
        placeholder="Optional note for the agent"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="oc-approval-bar__actions">
        <Button variant="primary" loading={pending} onClick={() => onApprove(note)}>
          Approve
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => onReject(note)}>
          Reject
        </Button>
      </div>
    </div>
  );
}
