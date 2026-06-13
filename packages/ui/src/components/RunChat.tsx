import type { ReactNode } from 'react';
import { cx } from '../cx';
import { LiveIndicator } from './LiveIndicator';
import type { TimelineEvent } from './EventTimeline';

/** How a run event reads in the chat transcript. */
type RowKind = 'prose' | 'reasoning' | 'action' | 'error' | 'awaiting' | 'meta';

/**
 * Per-event-type presentation. The agent's narration (`text`) is the prose
 * spine; reasoning + raw action payloads collapse behind a calm disclosure;
 * lifecycle bookkeeping (`status`/`step`/`billing`/`done`/…) is demoted to
 * subtle centred system markers so a chatty run still reads like a quiet
 * conversation rather than a log dump.
 */
const ROW_KIND: Record<string, RowKind> = {
  text: 'prose',
  reasoning: 'reasoning',
  tool_call: 'action',
  action: 'action',
  tool_result: 'action',
  error: 'error',
  ingest_error: 'error',
  awaiting_human: 'awaiting',
  status: 'meta',
  step: 'meta',
  billing: 'meta',
  resumed: 'meta',
  done: 'meta',
  prediction: 'meta',
};

/** The single live screenshot frame stands in for these — no text row needed. */
const HIDDEN_TYPES = new Set(['screenshot']);

function rowKind(type: string): RowKind {
  // Unknown types keep their label + JSON detail behind the action disclosure
  // so nothing is silently lost.
  return ROW_KIND[type] ?? 'action';
}

/** Props for {@link RunChat}. */
export interface RunChatProps {
  /** The delegated instruction — rendered as the opening user message. */
  task: string;
  /** Run events in ascending `seq` order (already mapped to {@link TimelineEvent}). */
  events: TimelineEvent[];
  /** While true and the run has not narrated yet, shows a quiet "starting" line. */
  working?: boolean;
  /** Label for the starting line. Default "Starting…". */
  workingLabel?: string;
  /**
   * Appended after the live event log — the page injects the live "shared
   * screen" card and (on terminal) the summary here, so they read as the tail
   * of the conversation.
   */
  children?: ReactNode;
  className?: string;
}

function ChatRow({ event }: { event: TimelineEvent }) {
  const kind = rowKind(event.type);

  if (kind === 'meta') {
    return (
      <li className="oc-chat__row oc-chat__row--meta">
        <span className="oc-chat__meta">{event.label}</span>
      </li>
    );
  }

  if (kind === 'reasoning') {
    return (
      <li className="oc-chat__row oc-chat__row--agent">
        <details className="oc-chat__disclosure oc-timeline__detail">
          <summary>{event.label}</summary>
          {event.detail ? <pre>{event.detail}</pre> : null}
        </details>
      </li>
    );
  }

  if (kind === 'action') {
    return (
      <li className="oc-chat__row oc-chat__row--agent">
        <div className="oc-chat__action">
          <span className="oc-chat__action-label">{event.label}</span>
          {event.detail ? (
            <details className="oc-chat__disclosure oc-timeline__detail">
              <summary>Details</summary>
              <pre>{event.detail}</pre>
            </details>
          ) : null}
        </div>
      </li>
    );
  }

  // prose / error / awaiting — the conversational spine.
  return (
    <li
      className={cx(
        'oc-chat__row oc-chat__row--agent',
        kind === 'error' && 'oc-chat__row--error',
        kind === 'awaiting' && 'oc-chat__row--awaiting',
      )}
    >
      <p className="oc-chat__prose">{event.label}</p>
    </li>
  );
}

/**
 * The run rendered as a calm, single-column chat transcript: the delegated task
 * is the opening user message (a quiet filled bubble), and the agent's
 * narration / reasoning / actions stream below it as bubble-less prose. Raw
 * payloads stay collapsed; lifecycle events become subtle system markers. The
 * event list is a `role="log"` live region so screen readers announce new
 * activity. Purely presentational — apps map run events into {@link TimelineEvent}
 * and inject the live screen + summary via `children`.
 */
export function RunChat({
  task,
  events,
  working = false,
  workingLabel = 'Starting…',
  children,
  className,
}: RunChatProps) {
  const rows = events.filter((e) => !HIDDEN_TYPES.has(e.type));

  return (
    <div className={cx('oc-chat', className)}>
      <div className="oc-chat__turn oc-chat__turn--user">
        <span className="oc-chat__role">Task</span>
        <div className="oc-chat__bubble">{task}</div>
      </div>

      <ol role="log" aria-label="Run activity" className="oc-chat__log">
        {rows.map((event) => (
          <ChatRow key={event.seq} event={event} />
        ))}
        {working && rows.length === 0 ? (
          <li className="oc-chat__row oc-chat__row--meta">
            <LiveIndicator label={workingLabel} />
          </li>
        ) : null}
      </ol>

      {children}
    </div>
  );
}
