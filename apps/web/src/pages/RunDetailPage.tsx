/**
 * Live run view, rendered as a chat transcript: the delegated task is the
 * opening message and the agent's narration / actions stream below it over SSE
 * (with reconnect). One live "shared screen" frame (the machine screenshot for
 * cloud runs, the forwarded desktop screen for local runs) tails the thread and
 * can be zoomed; the bottom dock — shaped like the Delegate composer — reports
 * working status, morphs into the approval bar when the agent pauses for a
 * human, and into a finish/return footer once the run is terminal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApprovalBar,
  Button,
  CostPill,
  ErrorState,
  Heading,
  Icon,
  LiveIndicator,
  Modal,
  RunChat,
  RunStatusBadge,
  ScreenView,
  Spinner,
  formatCents,
  type RunStatus,
} from '@open-cowork/ui';
import { getClient } from '../store';
import { useSse } from '../api/useSse';
import { eventToTimeline } from '../mapEvents';
import type { RunDto } from '../api/client';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const client = getClient();
  const [run, setRun] = useState<RunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [frame, setFrame] = useState<{ b64: string; at: string } | null>(null);
  const [zoom, setZoom] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
  // runs: poll the local-run frame channel the desktop forwards into. Polling
  // runs only while the run is active; the last captured frame stays on screen
  // after it finishes (relabelled "Final screen").
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
        // screenshot polling is best-effort; the transcript still tells the story
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), kind === 'local' ? 1500 : 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [client, kind, machineId, runId, active]);

  const timeline = useMemo(() => events.map(eventToTimeline), [events]);

  // Auto-scroll to the latest activity — but only when the user is already near
  // the bottom, so scrolling up to read history is never fought.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const scroller = el.closest('.app-main');
    if (scroller instanceof HTMLElement) {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200;
      if (!nearBottom) return;
    }
    try {
      el.scrollIntoView({ block: 'end', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch {
      // jsdom / unsupported environments — scrolling is a progressive nicety
    }
  }, [timeline.length, run?.status]);

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

  const terminal = TERMINAL.has(run.status);
  const isLocal = run.kind === 'local';
  const screenAlt = isLocal ? 'Local screen' : 'Machine screen';
  const screenLabel = terminal ? 'Final screen' : isLocal ? 'Your screen' : 'Shared screen';

  return (
    <div className="run-chat-page">
      <h1 className="sr-only">Run details</h1>
      <header className="run-chat-page__header">
        <div className="run-chat-page__id">
          <RunStatusBadge status={run.status as RunStatus} />
          <span className="run-chat-page__id-machine">
            <Icon
              name={isLocal ? 'laptop' : 'cloud'}
              size={15}
              title={isLocal ? 'Local run' : 'Cloud run'}
            />
            {isLocal ? 'This computer' : 'Cloud machine'}
          </span>
          <span className="run-chat-page__steps">
            {run.stepsCompleted} / {run.maxSteps} steps
          </span>
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
      </header>

      <RunChat className="run-chat-page__body" task={run.task} events={timeline} working={active}>
        {streamError && events.length === 0 && active ? (
          <p className="oc-chat__screen-note" role="status">
            Reconnecting to the live stream…
          </p>
        ) : null}

        {frame || active ? (
          <figure className="oc-chat__screen">
            <figcaption className="oc-chat__screen-head">
              <Icon name={isLocal ? 'laptop' : 'cloud'} size={15} />
              {screenLabel}
              {active && connected ? <LiveIndicator /> : null}
            </figcaption>
            <button
              type="button"
              className="oc-chat__screen-btn"
              onClick={() => setZoom(true)}
              disabled={!frame}
              aria-label={frame ? 'Expand screen' : 'No screen captured yet'}
            >
              <ScreenView
                frameB64={frame?.b64}
                live={active && connected}
                lastFrameAt={frame?.at}
                staleAfterSeconds={10}
                alt={screenAlt}
              />
            </button>
            {isLocal ? (
              <p className="oc-chat__screen-note">
                This is a live view of your own screen, captured by the desktop app each step.
              </p>
            ) : null}
          </figure>
        ) : null}

        {terminal ? (
          <section className="oc-chat__summary" aria-label="Run summary">
            <Heading level={2} className="oc-chat__summary-title">
              Summary
            </Heading>
            <p className="oc-chat__summary-line">
              Finished <strong>{run.status}</strong> after {run.stepsCompleted} steps — total cost{' '}
              <CostPill cents={run.costCents} variant="actual" />
            </p>
            {run.result?.summary ? (
              <p className="oc-chat__summary-note">{run.result.summary}</p>
            ) : null}
            {run.error?.message ? (
              <ErrorState message={`${run.error.code ?? 'ERROR'}: ${run.error.message}`} />
            ) : null}
          </section>
        ) : null}
      </RunChat>

      <div className="run-chat-page__dock">
        {run.status === 'awaiting_human' ? (
          <ApprovalBar
            reason={run.awaitingHumanReason ?? 'The agent paused for a human decision.'}
            pending={actionPending}
            onApprove={(note) => void approve(note)}
            onReject={() => void cancel()}
          />
        ) : active ? (
          <div className="oc-chat-dock__shell">
            <span className="oc-chat-dock__status">
              Working — step {run.stepsCompleted} of {run.maxSteps}
              <span className="oc-chat-dock__spent">· {formatCents(run.costCents)} spent</span>
            </span>
            {connected ? <LiveIndicator /> : null}
          </div>
        ) : (
          <div className="oc-chat-dock__shell">
            <span className="oc-chat-dock__status">Run {run.status}.</span>
            <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
              Delegate another task
            </Button>
          </div>
        )}
      </div>

      <div ref={bottomRef} aria-hidden="true" />

      <Modal
        open={zoom}
        onClose={() => setZoom(false)}
        title={screenLabel}
        className="oc-chat__screen-modal"
      >
        {frame ? (
          <img
            className="oc-chat__screen-zoom"
            src={`data:image/png;base64,${frame.b64}`}
            alt={screenAlt}
          />
        ) : (
          <p>No frame captured yet.</p>
        )}
      </Modal>
    </div>
  );
}
