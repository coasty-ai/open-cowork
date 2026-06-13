/**
 * Live run view: event timeline over SSE (with reconnect), a live screen view
 * (machine screenshot frames while running), human-takeover approval, cancel,
 * and the final cost summary.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApprovalBar,
  Button,
  Card,
  CostPill,
  ErrorState,
  EventTimeline,
  RunStatusBadge,
  ScreenView,
  Spinner,
  type RunStatus,
  Heading,
  Text,
} from '@open-cowork/ui';
import { getClient } from '../store';
import { useSse } from '../api/useSse';
import { eventToTimeline } from '../mapEvents';
import type { RunDto } from '../api/client';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const client = getClient();
  const [run, setRun] = useState<RunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [frame, setFrame] = useState<{ b64: string; at: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setRun(await client.getRun(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the run');
    }
  }, [client, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live events; status changes also trigger a run refresh.
  const {
    events,
    connected,
    error: streamError,
  } = useSse({
    client,
    path: id ? `/api/runs/${id}/events` : null,
    onEvent: (e) => {
      if (
        e.type === 'status' ||
        e.type === 'awaiting_human' ||
        e.type === 'resumed' ||
        e.type === 'done'
      ) {
        void refresh();
      }
    },
  });

  // Live screen view. Cloud runs: poll the machine screenshot endpoint. Local
  // runs: poll the local-run frame channel the desktop forwards into. We keep
  // polling briefly after a run finishes so the final frame lands.
  const kind = run?.kind ?? null;
  const machineId = run?.kind === 'coasty' ? run.machineId : null;
  const runId = run?.id ?? null;
  const active = run !== null && !TERMINAL.has(run.status);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!active) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    const poll = async () => {
      try {
        if (kind === 'coasty' && machineId) {
          const shot = await client.machineScreenshot(machineId);
          setFrame({ b64: shot.image_b64, at: shot.captured_at });
        } else if (kind === 'local' && runId) {
          const f = await client.localRunFrame(runId);
          if (f.base64) setFrame({ b64: f.base64, at: f.capturedAt ?? new Date().toISOString() });
        }
      } catch {
        // screenshot polling is best-effort; the timeline still tells the story
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), kind === 'local' ? 1500 : 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [client, kind, machineId, runId, active]);

  const timeline = useMemo(() => events.map(eventToTimeline), [events]);

  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;
  if (!run) return <Spinner aria-label="Loading run" />;

  const approve = async (note: string) => {
    setActionPending(true);
    try {
      await client.resumeRun(run.id, note || undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setActionPending(false);
    }
  };

  const cancel = async () => {
    setActionPending(true);
    try {
      await client.cancelRun(run.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setActionPending(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div className="row">
          <RunStatusBadge status={run.status as RunStatus} />
          <Heading level={1} className="run-title">
            {run.task}
          </Heading>
        </div>
        <div className="row">
          <CostPill cents={run.costCents} variant="actual" />
          {active ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void cancel()}
              loading={actionPending}
            >
              Cancel run
            </Button>
          ) : null}
        </div>
      </div>

      {run.status === 'awaiting_human' ? (
        <ApprovalBar
          reason={run.awaitingHumanReason ?? 'The agent paused for a human decision.'}
          pending={actionPending}
          onApprove={(note) => void approve(note)}
          onReject={() => void cancel()}
        />
      ) : null}

      <div className="run-detail-grid">
        <Card>
          <Heading level={4}>
            {run.kind === 'local' ? 'Your screen (local run)' : 'Machine screen'}
          </Heading>
          <ScreenView
            frameB64={frame?.b64}
            live={active && connected}
            lastFrameAt={frame?.at}
            staleAfterSeconds={10}
            alt={run.kind === 'local' ? 'Local screen' : 'Remote machine screen'}
          />
          {run.kind === 'local' ? (
            <Text variant="caption" as="p">
              This is a live view of your own screen, captured by the desktop app each step.
            </Text>
          ) : null}
        </Card>
        <Card>
          <Heading level={4}>
            Timeline{' '}
            {connected ? <span style={{ color: 'var(--color-success)' }}>· live</span> : null}
          </Heading>
          {streamError && events.length === 0 ? (
            <ErrorState message={`Event stream: ${streamError}`} />
          ) : null}
          <EventTimeline
            events={timeline}
            loading={events.length === 0 && active}
            emptyTitle="No events yet"
          />
        </Card>
      </div>

      {TERMINAL.has(run.status) ? (
        <Card>
          <Heading level={4}>Summary</Heading>
          <p>
            Finished <strong>{run.status}</strong> after {run.stepsCompleted} steps — total cost{' '}
            <CostPill cents={run.costCents} variant="actual" />.
          </p>
          {run.result?.summary ? <p className="notice">{run.result.summary}</p> : null}
          {run.error?.message ? (
            <ErrorState message={`${run.error.code ?? 'ERROR'}: ${run.error.message}`} />
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
