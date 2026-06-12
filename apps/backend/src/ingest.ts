/**
 * Run-event ingestion: one background subscription per active Coasty run /
 * workflow run. Mirrors upstream SSE events (keeping the upstream `seq`!) into
 * the events table, publishes them on the bus, and keeps the run row's status,
 * steps, and cost in sync. Reconnects via Last-Event-ID; stops on terminal
 * events or dispose().
 */
import type { CoastyClient, RunEvent } from '@open-cowork/core';
import type { Db } from './db';
import type { EventBus } from './bus';

export type StreamKind = 'run' | 'workflow-run';

export interface IngestTarget {
  kind: StreamKind;
  /** Our row id (runs.id / workflow_runs.id) — the stream id clients use. */
  localId: string;
  /** Coasty's id (run_… / wfr_…). */
  coastyId: string;
  userId: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class Ingestor {
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly coasty: CoastyClient,
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  /** Start (or restart) ingestion for a run. Idempotent per localId. */
  start(target: IngestTarget): void {
    if (this.controllers.has(target.localId)) return;
    const controller = new AbortController();
    this.controllers.set(target.localId, controller);
    void this.pump(target, controller.signal).finally(() => {
      this.controllers.delete(target.localId);
    });
  }

  private async pump(target: IngestTarget, signal: AbortSignal): Promise<void> {
    const last = this.db.eventsAfter(target.kind, target.localId, 0).at(-1)?.seq ?? 0;
    const stream =
      target.kind === 'run'
        ? this.coasty.streamRunEvents(target.coastyId, { signal, lastEventId: last })
        : this.coasty.streamWorkflowRunEvents(target.coastyId, { signal, lastEventId: last });
    try {
      for await (const evt of stream) {
        this.handleEvent(target, evt);
        if (evt.type === 'done') break;
      }
    } catch (err) {
      if (!signal.aborted) {
        // The client already retried internally; reaching here means the stream
        // is genuinely gone. Record the gap so supervising UIs can show it.
        const seq = this.db.appendEvent(target.kind, target.localId, 'ingest_error', {
          message: err instanceof Error ? err.message : String(err),
        });
        this.bus.publish({
          streamKind: target.kind,
          streamId: target.localId,
          seq,
          type: 'ingest_error',
          data: { message: 'event stream lost' },
          userId: target.userId,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  private handleEvent(target: IngestTarget, evt: RunEvent): void {
    const inserted = this.db.ingestEvent(target.kind, target.localId, evt.seq, String(evt.type), evt.data);
    if (!inserted) return; // replay overlap — already stored + published

    this.applyStateChange(target, evt);
    this.bus.publish({
      streamKind: target.kind,
      streamId: target.localId,
      seq: evt.seq,
      type: String(evt.type),
      data: evt.data,
      userId: target.userId,
      createdAt: new Date().toISOString(),
    });
  }

  private applyStateChange(target: IngestTarget, evt: RunEvent): void {
    const data = evt.data as Record<string, unknown>;
    if (target.kind === 'run') {
      switch (evt.type) {
        case 'status': {
          const status = typeof data.status === 'string' ? data.status : undefined;
          if (status) {
            this.db.updateRun(target.localId, {
              status,
              ...(TERMINAL.has(status) ? { finished_at: new Date().toISOString() } : {}),
            });
          }
          break;
        }
        case 'step': {
          if (typeof data.steps_completed === 'number') {
            this.db.updateRun(target.localId, { steps_completed: data.steps_completed });
          }
          break;
        }
        case 'billing': {
          if (typeof data.cost_cents === 'number') {
            this.db.updateRun(target.localId, { cost_cents: data.cost_cents });
          }
          break;
        }
        case 'awaiting_human': {
          this.db.updateRun(target.localId, {
            status: 'awaiting_human',
            awaiting_human_reason: typeof data.reason === 'string' ? data.reason : 'Human takeover requested',
          });
          break;
        }
        case 'resumed': {
          this.db.updateRun(target.localId, { status: 'running', awaiting_human_reason: null });
          break;
        }
        case 'done': {
          const status = typeof data.status === 'string' ? data.status : 'succeeded';
          this.db.updateRun(target.localId, {
            status,
            finished_at: new Date().toISOString(),
            ...(data.result !== undefined ? { result_json: JSON.stringify(data.result) } : {}),
          });
          break;
        }
        case 'error': {
          this.db.updateRun(target.localId, { error_json: JSON.stringify(data) });
          break;
        }
        default:
          break;
      }
    } else {
      switch (evt.type) {
        case 'status': {
          const status = typeof data.status === 'string' ? data.status : undefined;
          if (status) {
            this.db.updateWorkflowRun(target.localId, {
              status,
              ...(TERMINAL.has(status) ? { finished_at: new Date().toISOString() } : {}),
            });
          }
          break;
        }
        case 'billing': {
          if (typeof data.spent_cents === 'number') {
            this.db.updateWorkflowRun(target.localId, { spent_cents: data.spent_cents });
          }
          break;
        }
        case 'awaiting_human': {
          this.db.updateWorkflowRun(target.localId, {
            status: 'awaiting_human',
            awaiting_step_id: typeof data.step_id === 'string' ? data.step_id : null,
          });
          break;
        }
        case 'resumed': {
          this.db.updateWorkflowRun(target.localId, { status: 'running', awaiting_step_id: null });
          break;
        }
        case 'done': {
          const status = typeof data.status === 'string' ? data.status : 'succeeded';
          this.db.updateWorkflowRun(target.localId, { status, finished_at: new Date().toISOString() });
          break;
        }
        default:
          break;
      }
    }
  }

  /** Stop all subscriptions (server shutdown). */
  dispose(): void {
    for (const [, controller] of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
