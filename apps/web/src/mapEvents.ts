/**
 * Map raw run/workflow events (Coasty event types) into the presentational
 * TimelineEvent shape @open-cowork/ui renders.
 */
import type { TimelineEvent } from '@open-cowork/ui';
import type { SseEventItem } from './api/useSse';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function eventToTimeline(event: SseEventItem): TimelineEvent {
  const d = event.data;
  let label: string;
  let detail: string | undefined;
  switch (event.type) {
    case 'status':
      label = `Status → ${asString(d.status) ?? 'unknown'}`;
      break;
    case 'text':
      label = asString(d.text) ?? asString(d.message) ?? 'Agent narration';
      break;
    case 'reasoning':
      label = 'Model reasoning';
      detail = asString(d.text) ?? JSON.stringify(d);
      break;
    case 'tool_call': {
      const tool = asString(d.tool) ?? asString(d.action_type) ?? asString(d.command) ?? 'action';
      label = `Action: ${tool}`;
      detail = JSON.stringify(d, null, 2);
      break;
    }
    case 'tool_result':
      label = 'Action result';
      detail = JSON.stringify(d, null, 2);
      break;
    case 'step':
      label = `Step ${String(d.steps_completed ?? '?')} completed`;
      break;
    case 'billing':
      label = `Spend so far: $${(Number(d.cost_cents ?? d.spent_cents ?? 0) / 100).toFixed(2)}`;
      break;
    case 'awaiting_human':
      label = `Waiting for a human${asString(d.reason) ? ` — ${asString(d.reason)}` : ''}`;
      break;
    case 'resumed':
      label = 'Resumed by a human';
      detail = asString(d.note);
      break;
    case 'error':
      label = `Error: ${asString(d.message) ?? 'unknown'}`;
      detail = JSON.stringify(d, null, 2);
      break;
    case 'ingest_error':
      label = 'Event stream interrupted (backend is retrying)';
      break;
    case 'done':
      label = `Finished: ${asString(d.status) ?? 'done'}`;
      break;
    case 'screenshot':
      label = 'Screenshot captured';
      break;
    case 'prediction':
      label = `Predicted ${String(d.actionCount ?? '?')} action(s)`;
      detail = asString(d.reasoning);
      break;
    case 'action':
      label = `Action: ${asString((d.action as Record<string, unknown> | undefined)?.action_type as string) ?? 'action'}`;
      detail = JSON.stringify(d.action ?? d, null, 2);
      break;
    default:
      label = event.type;
      detail = JSON.stringify(d, null, 2);
  }
  return { seq: event.seq, type: event.type, label, detail };
}
