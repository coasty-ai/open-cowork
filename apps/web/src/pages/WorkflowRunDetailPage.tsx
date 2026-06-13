/**
 * Live workflow-run view: SSE timeline, approve/reject for human_approval
 * steps, cancel, budget gauge, and final output.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApprovalBar,
  Button,
  Card,
  CodeBlock,
  ErrorState,
  EventTimeline,
  RunStatusBadge,
  Spinner,
  type RunStatus,
} from '@open-cowork/ui';
import { getClient } from '../store';
import { useSse } from '../api/useSse';
import { eventToTimeline } from '../mapEvents';
import type { WorkflowRunDto } from '../api/client';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function WorkflowRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const client = getClient();
  const [run, setRun] = useState<WorkflowRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setRun(await client.getWorkflowRun(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the workflow run');
    }
  }, [client, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { events, connected } = useSse({
    client,
    path: id ? `/api/workflows/runs/${id}/events` : null,
    onEvent: (e) => {
      if (['status', 'awaiting_human', 'resumed', 'done'].includes(e.type)) void refresh();
    },
  });
  const timeline = useMemo(() => events.map(eventToTimeline), [events]);

  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;
  if (!run) return <Spinner aria-label="Loading workflow run" />;

  const decide = async (approved: boolean, note: string) => {
    setPending(true);
    try {
      await client.resumeWorkflowRun(run.id, approved, note || undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setPending(false);
    }
  };

  const cancel = async () => {
    setPending(true);
    try {
      await client.cancelWorkflowRun(run.id);
      await refresh();
    } finally {
      setPending(false);
    }
  };

  const active = !TERMINAL.has(run.status);

  return (
    <>
      <div className="page-header">
        <div className="row">
          <RunStatusBadge status={run.status as RunStatus} />
          <h1 className="page-title">Workflow run {run.id}</h1>
        </div>
        <div className="row">
          <span className="notice" style={{ padding: '4px 10px' }}>
            spent ${(run.spentCents / 100).toFixed(2)} / cap ${(run.budgetCents / 100).toFixed(2)}
          </span>
          {active ? (
            <Button variant="danger" size="sm" onClick={() => void cancel()} loading={pending}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {run.status === 'awaiting_human' ? (
        <ApprovalBar
          reason={
            run.awaitingReason ??
            (run.awaitingStepId
              ? `Step '${run.awaitingStepId}' needs your approval.`
              : 'Approval required.')
          }
          pending={pending}
          onApprove={(note) => void decide(true, note)}
          onReject={(note) => void decide(false, note)}
        />
      ) : null}

      <Card>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>
          Timeline{' '}
          {connected ? <span style={{ color: 'var(--color-success)' }}>· live</span> : null}
        </h2>
        <EventTimeline
          events={timeline}
          loading={events.length === 0 && active}
          emptyTitle="No events yet"
        />
      </Card>

      {TERMINAL.has(run.status) ? (
        <Card>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Result</h2>
          {run.output ? <CodeBlock code={JSON.stringify(run.output, null, 2)} /> : null}
          {run.error?.message ? (
            <ErrorState message={`${run.error.code ?? 'ERROR'}: ${run.error.message}`} />
          ) : null}
          {!run.output && !run.error ? <p>Finished {run.status}.</p> : null}
        </Card>
      ) : null}
    </>
  );
}
