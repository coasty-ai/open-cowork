/**
 * In-memory state for the mock Coasty server, plus the per-stream event log
 * with live listeners (the durable-replay SSE model the real API documents).
 */
import { buildSignature, nowIso } from './util';

export type KeyKind = 'test' | 'live' | 'legacy';

export interface StoredEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface SessionRec {
  session_id: string;
  cua_version: string;
  screen_width: number;
  screen_height: number;
  step_count: number;
  created_at: string;
  expires_at: string;
  total_credits_used: number;
}

export interface MachineRec {
  id: string;
  display_name: string;
  status: string;
  os_type: 'linux' | 'windows';
  provider: string;
  desktop_enabled: boolean;
  cpu_cores: number;
  memory_gb: number;
  storage_gb: number;
  public_ip: string;
  is_test: boolean;
  created_at: string;
  metadata: Record<string, string>;
  ttl_minutes: number | null;
  files: Map<string, string>;
  frame: number;
}

export interface RunRec {
  id: string;
  object: 'agent.run';
  status: string;
  machine_id: string;
  task: string;
  cua_version: string;
  instructions: string | null;
  max_steps: number;
  on_awaiting_human: 'pause' | 'fail' | 'cancel';
  steps_completed: number;
  credits_charged: number;
  cost_cents: number;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  awaiting_human_reason: string | null;
  metadata: Record<string, unknown> | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  created_at: string;
  started_at: string | null;
  awaiting_human_since: string | null;
  finished_at: string | null;
  request_id: string;
  // internals
  deadlineAt: number | null;
  stepsTarget: number;
}

export interface WorkflowRec {
  id: string;
  object: 'workflow';
  name: string;
  slug: string;
  version: number;
  dsl_version: string;
  definition: Record<string, unknown>;
  inputs_schema: Record<string, unknown> | null;
  description: string | null;
  status: 'active' | 'archived';
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRec {
  id: string;
  object: 'workflow.run';
  status: string;
  workflow_id: string | null;
  workflow_version: number | null;
  machine_id: string | null;
  inputs: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  awaiting_human_reason: string | null;
  awaiting_step_id: string | null;
  iterations_used: number;
  spent_cents: number;
  budget_cents: number;
  webhook_url: string | null;
  webhook_secret: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  request_id: string;
  // internals
  definitionSnapshot: Record<string, unknown>;
  approvalResolve: ((decision: { approved: boolean; note?: string }) => void) | null;
  cancelled: boolean;
  deadlineAt: number | null;
}

export interface WebhookDelivery {
  url: string;
  body: string;
  headers: Record<string, string>;
  ok: boolean;
  status: number | null;
  event: string;
}

export interface IdempotencyEntry {
  bodyHash: string;
  status: number;
  payload: unknown;
}

type Listener = (event: StoredEvent) => void;

export class MockState {
  walletCents: number;
  readonly sessions = new Map<string, SessionRec>();
  readonly machines = new Map<string, MachineRec>();
  readonly runs = new Map<string, RunRec>();
  readonly workflows = new Map<string, WorkflowRec>();
  readonly workflowRuns = new Map<string, WorkflowRunRec>();
  readonly events = new Map<string, StoredEvent[]>();
  readonly idempotency = new Map<string, IdempotencyEntry>();
  readonly webhookDeliveries: WebhookDelivery[] = [];
  readonly usage = {
    totalRequests: 0,
    totalCredits: 0,
    breakdown: {} as Record<string, { requests: number; credits: number }>,
  };
  private listeners = new Map<string, Set<Listener>>();
  readonly timers = new Set<NodeJS.Timeout>();
  closed = false;

  constructor(walletCents: number) {
    this.walletCents = walletCents;
  }

  /** Append an event to a stream (seq starts at 1) and notify live listeners. */
  emit(streamId: string, type: string, data: Record<string, unknown>): StoredEvent {
    let log = this.events.get(streamId);
    if (!log) {
      log = [];
      this.events.set(streamId, log);
    }
    const event: StoredEvent = { seq: log.length + 1, type, data, created_at: nowIso() };
    log.push(event);
    for (const listener of this.listeners.get(streamId) ?? []) {
      try {
        listener(event);
      } catch {
        // a broken SSE connection must never break the stepper
      }
    }
    return event;
  }

  eventsAfter(streamId: string, after: number): StoredEvent[] {
    return (this.events.get(streamId) ?? []).filter((e) => e.seq > after);
  }

  subscribe(streamId: string, listener: Listener): () => void {
    let set = this.listeners.get(streamId);
    if (!set) {
      set = new Set();
      this.listeners.set(streamId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  addTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.timers.add(timer);
    return timer;
  }

  clearTimers(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
  }

  recordUsage(family: string, credits: number): void {
    this.usage.totalRequests++;
    this.usage.totalCredits += credits;
    const entry = (this.usage.breakdown[family] ??= { requests: 0, credits: 0 });
    entry.requests++;
    entry.credits += credits;
  }

  /** Deliver a signed webhook (one retry), recording every attempt. */
  async deliverWebhook(url: string, secret: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ event, ...payload, created_at: nowIso() });
    const headers = {
      'Content-Type': 'application/json',
      'Coasty-Signature': buildSignature(secret, body, Math.floor(Date.now() / 1000)),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body });
        this.webhookDeliveries.push({ url, body, headers, ok: res.ok, status: res.status, event });
        if (res.ok) return;
      } catch {
        this.webhookDeliveries.push({ url, body, headers, ok: false, status: null, event });
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }

  reset(): void {
    this.sessions.clear();
    this.machines.clear();
    this.runs.clear();
    this.workflows.clear();
    this.workflowRuns.clear();
    this.events.clear();
    this.idempotency.clear();
    this.webhookDeliveries.length = 0;
  }
}
