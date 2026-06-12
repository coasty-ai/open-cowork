import { cx } from '../cx';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

/**
 * One rendered timeline entry. Apps map core/Coasty run events
 * (`{ seq, type, data, created_at }`) into this presentational shape.
 */
export interface TimelineEvent {
  /** Monotonic sequence number; used as the React key and SSE cursor. */
  seq: number;
  /** Coasty event type (`status`, `step`, `tool_call`, `billing`, ...). */
  type: string;
  /** Primary human-readable line. */
  label: string;
  /** Optional long-form payload, shown inside a collapsible `<details>`. */
  detail?: string;
  /** Optional ISO-8601 timestamp. */
  at?: string;
}

/** Props for {@link EventTimeline}. */
export interface EventTimelineProps {
  /** Events in ascending `seq` order. */
  events: TimelineEvent[];
  /** Shows a spinner instead of the list while the first page loads. */
  loading?: boolean;
  /** Title of the empty state shown when there are no events. */
  emptyTitle?: string;
  className?: string;
}

/** Per-event-type glyph, mirroring the documented Coasty run event types. */
const GLYPHS: Record<string, string> = {
  status: '◆',
  text: '✎',
  reasoning: '…',
  tool_call: '⚙',
  tool_result: '↩',
  awaiting_human: '⏸',
  resumed: '▶',
  step: '➜',
  billing: '¢',
  error: '⚠',
  done: '✓',
};

const DEFAULT_GLYPH = '•';

/**
 * Live run event timeline: an `<ol role="log">` so screen readers announce
 * appended events. Empty input renders an {@link EmptyState}; `loading`
 * renders a {@link Spinner}.
 */
export function EventTimeline({
  events,
  loading = false,
  emptyTitle = 'No events yet',
  className,
}: EventTimelineProps) {
  if (loading) {
    return (
      <div className={cx('oc-timeline', className)}>
        <Spinner label="Loading events" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description="Events will appear here as the run progresses."
        className={className}
      />
    );
  }
  return (
    <ol role="log" className={cx('oc-timeline', className)}>
      {events.map((event) => (
        <li key={event.seq} className={cx('oc-timeline__item', `oc-timeline__item--${event.type}`)}>
          <span className="oc-timeline__glyph" aria-hidden="true">
            {GLYPHS[event.type] ?? DEFAULT_GLYPH}
          </span>
          <div className="oc-timeline__body">
            <p className="oc-timeline__label">
              {event.label}
              {event.at ? (
                <time className="oc-timeline__at" dateTime={event.at}>
                  {event.at}
                </time>
              ) : null}
            </p>
            {event.detail ? (
              <details className="oc-timeline__detail">
                <summary>Detail</summary>
                <pre>{event.detail}</pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
