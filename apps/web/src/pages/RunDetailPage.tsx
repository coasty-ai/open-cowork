/**
 * Live run view, as a side-by-side "control room": the conversation lives on the
 * left — the delegated task as the opening message, the agent's narration /
 * actions streaming below it over SSE (with reconnect), and a status dock pinned
 * to the foot — while the machine's live screen sits on the right, always in
 * view as the hero. The screen is the machine screenshot for cloud runs, the
 * forwarded desktop screen for local runs; it can be zoomed. The dock morphs:
 * working status while active, the approval bar when the agent pauses for a
 * human, a finish/return footer once the run is terminal. On narrow viewports
 * the split collapses to a single scrolling column (screen first).
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

/** Bound on how many metadata pages we walk to find a run's final frame. */
const MAX_FRAME_PAGES = 20;

/** How often to re-check a finished task whose machine cleanup is still in flight. */
const CLEANUP_POLL_MS = 1500;
/** Give up after this many checks — the machine's TTL is authoritative regardless. */
const CLEANUP_POLL_MAX_ATTEMPTS = 40;

/**
 * Fetch the LAST model-input frame of a run, with its bytes.
 *
 * Frames page forward from oldest, and only `after_index` is a cursor, so
 * finding the newest means walking metadata (cheap — a few hundred bytes per
 * frame) to learn the final index, then asking for that one frame WITH its
 * image. Doing it the naive way (`includeImage` on the first page) would return
 * the oldest frames and clamp the page to 10 for nothing.
 */
async function fetchLastModelFrame(
  client: ReturnType<typeof getClient>,
  runId: string,
): Promise<{ b64: string; at: string } | null> {
  let afterIndex: number | undefined;
  let lastIndex = -1;
  for (let page = 0; page < MAX_FRAME_PAGES; page++) {
    const res = await client.listRunScreenshots(runId, { afterIndex, limit: 200 });
    if (res.data.length === 0) break;
    lastIndex = res.data[res.data.length - 1]!.index;
    if (!res.has_more) break;
    afterIndex = lastIndex;
  }
  if (lastIndex < 0) return null;
  const page = await client.listRunScreenshots(runId, {
    // `after_index` is exclusive, and index 0 has nothing before it to skip.
    ...(lastIndex > 0 ? { afterIndex: lastIndex - 1 } : {}),
    limit: 1,
    includeImage: true,
  });
  const frame = page.data[0];
  return frame?.image_b64 ? { b64: frame.image_b64, at: frame.taken_at } : null;
}

/**
 * Plain-language status for a managed task's ephemeral machine.
 *
 * The subtlety worth surfacing to a user: a task finishing is NOT proof its
 * machine was destroyed. Cleanup begins after the terminal transition and can
 * still be in flight (or retrying) when the run already reads "succeeded", so
 * `terminating`/`retrying` get their own wording rather than being rounded up
 * to "shut down".
 */
function managedMachineNote(run: RunDto): string | null {
  if (run.kind !== 'task') return null;
  const machine = run.machine;
  if (!machine) return 'Coasty is preparing a machine for this task.';
  switch (machine.cleanup_status) {
    case 'pending':
      return machine.status === 'provisioning'
        ? 'Coasty is provisioning a fresh machine for this task.'
        : 'Running on a Coasty-managed machine, destroyed when the task finishes.';
    case 'terminating':
      return 'The task has finished. Its machine is being shut down.';
    case 'retrying':
      return 'The task has finished, but shutting its machine down is being retried. The machine’s TTL will terminate it regardless.';
    case 'terminated':
      return 'The task finished and its machine was shut down.';
    case 'failed':
      return 'The task finished, but its machine could not be confirmed shut down. Check the Machines page.';
    default:
      return null;
  }
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const edgeRafRef = useRef(0);

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

  // A managed task keeps changing AFTER it goes terminal: cleanup of its
  // ephemeral machine starts once the run finishes and can still be in flight.
  // The event stream is closed by then and the screen poll only runs while the
  // run is active, so without this the page would sit on "being shut down"
  // forever and never tell the user the VM was actually destroyed.
  const cleanupStatus = run?.kind === 'task' ? (run.machine?.cleanup_status ?? null) : null;
  const cleanupPending =
    cleanupStatus !== null && cleanupStatus !== 'terminated' && cleanupStatus !== 'failed';
  useEffect(() => {
    if (!cleanupPending) return;
    // Bounded: `retrying` can persist, and the machine's TTL is authoritative
    // anyway, so we stop asking rather than polling a dead run indefinitely.
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > CLEANUP_POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      void refresh();
    }, CLEANUP_POLL_MS);
    return () => clearInterval(timer);
  }, [cleanupPending, refresh]);

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
  // runs: poll the local-run frame channel the desktop forwards into. We grab
  // one frame immediately — even for a finished run — so the stage shows the
  // final screen rather than an empty panel; the polling interval then only
  // keeps running while the run is active.
  const kind = run?.kind ?? null;
  const machineId = kind === 'coasty' || kind === 'task' ? (run?.machineId ?? null) : null;
  const runId = run?.id ?? null;
  const active = run !== null && !TERMINAL.has(run.status);
  // A managed task DESTROYS its machine when it finishes, so live screenshots
  // stop working the moment cleanup runs. The stored model-input frames are
  // then the only surviving evidence of what the agent saw.
  const machineGone = kind === 'task' && run?.machine?.cleanup_status !== 'pending' && !active;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        if (machineId && !machineGone) {
          const shot = await client.machineScreenshot(machineId);
          if (!cancelled) setFrame({ b64: shot.image_b64, at: shot.captured_at });
        } else if (kind === 'local' && runId) {
          const f = await client.localRunFrame(runId);
          if (!cancelled && f.base64) {
            setFrame({ b64: f.base64, at: f.capturedAt ?? new Date().toISOString() });
          }
        } else if (kind === 'task' && runId) {
          const last = await fetchLastModelFrame(client, runId);
          if (!cancelled && last) setFrame(last);
        }
      } catch {
        // screenshot polling is best-effort; the transcript still tells the story
      }
    };
    void poll();
    if (active) {
      pollRef.current = setInterval(() => void poll(), kind === 'local' ? 1500 : 2000);
    }
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [client, kind, machineId, runId, active, machineGone]);

  const timeline = useMemo(() => events.map(eventToTimeline), [events]);

  // The scrollbar is hidden for a calm, chrome-free rail, so a soft fade at the
  // top/bottom edge is the only cue that there's more to read. We toggle it via
  // data attributes (no re-render) so the fade shows only when content is
  // actually hidden in that direction — never over the task bubble or summary
  // at rest.
  const syncScrollEdges = useCallback(() => {
    const el = scrollRef.current;
    const rail = railRef.current;
    if (!el || !rail) return;
    rail.dataset.scrollUp = el.scrollTop > 4 ? 'true' : 'false';
    rail.dataset.scrollDown =
      el.scrollHeight - el.scrollTop - el.clientHeight > 4 ? 'true' : 'false';
  }, []);

  const onRailScroll = useCallback(() => {
    if (typeof requestAnimationFrame !== 'function') {
      syncScrollEdges();
      return;
    }
    if (edgeRafRef.current) return;
    edgeRafRef.current = requestAnimationFrame(() => {
      edgeRafRef.current = 0;
      syncScrollEdges();
    });
  }, [syncScrollEdges]);

  // Auto-scroll the transcript rail to the latest activity — but only when the
  // user is already near the bottom, so scrolling up to read history is never
  // fought. Keep the edge fades in sync as content and the viewport change.
  useEffect(() => {
    syncScrollEdges();
    const scroller = scrollRef.current;
    const el = bottomRef.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    if (scroller) {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200;
      if (!nearBottom) return;
    }
    try {
      el.scrollIntoView({ block: 'end', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch {
      // jsdom / unsupported environments — scrolling is a progressive nicety
    }
  }, [timeline.length, run?.status, syncScrollEdges]);

  useEffect(() => {
    const onResize = () => syncScrollEdges();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [syncScrollEdges]);

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
      // A local run executes in the desktop main process (LocalRunManager) —
      // abort the actual agent loop there. The backend /cancel only records
      // intent for a local run, so without this IPC the agent keeps driving the
      // real mouse/keyboard while the UI says "cancelled".
      if (run.kind === 'local' && window.cowork?.cancelLocalRun) {
        await window.cowork.cancelLocalRun();
      }
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
  const isManaged = run.kind === 'task';
  const screenAlt = isLocal ? 'Local screen' : 'Machine screen';
  const screenLabel = terminal ? 'Final screen' : isLocal ? 'Your screen' : 'Shared screen';
  const machineNote = managedMachineNote(run);

  return (
    <div className="run-split">
      <h1 className="sr-only">Run details</h1>
      <header className="run-split__header">
        <div className="run-split__meta">
          <RunStatusBadge status={run.status as RunStatus} />
          <span className="run-split__machine">
            <Icon
              name={isLocal ? 'laptop' : 'cloud'}
              size={15}
              title={isLocal ? 'Local run' : 'Cloud run'}
            />
            {isLocal ? 'This computer' : isManaged ? 'Managed machine' : 'Cloud machine'}
          </span>
          <span className="run-split__steps">
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

      <div className="run-split__body">
        {/* LEFT — the conversation rail: transcript scrolls, dock stays put. */}
        <section className="run-split__transcript">
          <div className="run-split__rail" ref={railRef}>
            <div
              className="run-split__scroll"
              ref={scrollRef}
              onScroll={onRailScroll}
              tabIndex={0}
              role="region"
              aria-label="Run transcript"
            >
              <RunChat task={run.task} events={timeline} working={active}>
                {streamError && events.length === 0 && active ? (
                  <p className="oc-chat__screen-note" role="status">
                    Reconnecting to the live stream…
                  </p>
                ) : null}

                {terminal ? (
                  <section className="oc-chat__summary" aria-label="Run summary">
                    <Heading level={2} className="oc-chat__summary-title">
                      Summary
                    </Heading>
                    <p className="oc-chat__summary-line">
                      Finished <strong>{run.status}</strong> after {run.stepsCompleted} steps —
                      total cost <CostPill cents={run.costCents} variant="actual" />
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
              <div ref={bottomRef} aria-hidden="true" />
            </div>
          </div>

          <div className="run-split__dock">
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
        </section>

        {/* RIGHT — the live screen stage: always in view, click to zoom. */}
        <aside className="run-split__stage" aria-label="Live screen">
          <div className="run-split__stage-head">
            <span className="run-split__stage-title">
              <Icon name={isLocal ? 'laptop' : 'cloud'} size={15} />
              {screenLabel}
            </span>
            {active && connected ? <LiveIndicator /> : null}
          </div>
          <div className="run-split__stage-frame">
            {frame ? (
              <button
                type="button"
                className="run-split__stage-btn"
                onClick={() => setZoom(true)}
                aria-label="Expand screen"
              >
                <ScreenView
                  frameB64={frame.b64}
                  live={active && connected}
                  lastFrameAt={frame.at}
                  staleAfterSeconds={active ? 10 : undefined}
                  alt={screenAlt}
                />
              </button>
            ) : active ? (
              <ScreenView live={connected} alt={screenAlt} />
            ) : (
              <p className="run-split__stage-empty">No screen was captured for this run.</p>
            )}
          </div>
          {isLocal ? (
            <p className="run-split__stage-note">
              This is a live view of your own screen, captured by the desktop app each step.
            </p>
          ) : null}
          {machineNote ? (
            <p className="run-split__stage-note" role="status">
              {machineNote}
            </p>
          ) : null}
        </aside>
      </div>

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
