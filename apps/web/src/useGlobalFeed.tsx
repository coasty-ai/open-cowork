/**
 * Global per-user activity feed: subscribes to the backend's notification
 * stream (SSE) and surfaces approval-needed banners + an offline indicator.
 * This is the cross-device loop: a run started on the desktop pops an
 * approval banner here (and on the phone) the moment it pauses.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSse } from './api/useSse';
import { getClient } from './store';
import { useAuth } from './store';

export interface GlobalFeedResult {
  offline: boolean;
  banner: ReactNode;
}

export function useGlobalFeed(): GlobalFeedResult {
  const token = useAuth((s) => s.token);
  const client = getClient();
  const [dismissed, setDismissed] = useState<number>(0);

  const { events, connected } = useSse({
    client,
    path: token ? '/api/events' : null,
    closeOnType: '__never__',
  });

  const banner = useMemo(() => {
    const pending = events.filter((e) => e.type.endsWith('awaiting_human') && e.seq > dismissed).at(-1);
    if (!pending) return null;
    const runId = (pending.data.runId ?? pending.data.workflowRunId) as string | undefined;
    const isWorkflow = pending.data.workflowRunId !== undefined;
    return (
      <div className="notice" role="status">
        ⏸ A {isWorkflow ? 'workflow' : 'run'} is waiting for your approval.{' '}
        {runId ? (
          <Link to={isWorkflow ? `/workflows/runs/${runId}` : `/runs/${runId}`}>Review it now</Link>
        ) : null}{' '}
        <button
          type="button"
          style={{ marginLeft: 8 }}
          onClick={() => setDismissed(pending.seq)}
          aria-label="Dismiss notification"
        >
          Dismiss
        </button>
      </div>
    );
  }, [events, dismissed]);

  // Only call it "offline" once a previously-working stream dropped (events
  // received earlier but no live connection now) — avoids a flash at startup.
  const offline = Boolean(token) && !connected && events.length > 0;
  return { offline, banner };
}
