/**
 * LocalRunManager — the desktop-side heart of "first-class local screen
 * control". It glues three already-tested pieces together:
 *
 *   1. the backend's local-run mirror   (POST /api/local-runs + event batches)
 *   2. the backend's inference proxy    (POST /api/proxy/sessions[…/predict])
 *   3. core's runAgentLoop driving an   @open-cowork/executor Executor
 *
 * so that a run executed on THIS machine shows up in every client (web,
 * mobile) exactly like a cloud run: live timeline, step counter, billing,
 * cancel. All deps are injected (backend URL, token getter, executor factory,
 * fetch), which keeps the class plainly unit-testable without Electron.
 *
 * Event mirroring keeps payloads small: screenshots are NEVER uploaded — the
 * timeline gets a one-line text marker per step instead. Events are flushed
 * in batches (every ~500ms or once 10 are queued) and the final `done` event
 * is always the last one appended.
 */
import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentLoopOutcome,
  type CreateSessionResponse,
  type PredictStepInput,
  type PredictStepResult,
  type SessionPredictResponse,
} from '@open-cowork/core';
import type { Executor } from '@open-cowork/executor';

/** One event row appended to the backend's run timeline. */
export interface BackendRunEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface LocalRunManagerDeps {
  /** Absolute backend base URL, e.g. http://127.0.0.1:4000 */
  backendUrl: string;
  /** Session token getter — on desktop the token arrives with each IPC call. */
  getToken: () => string | null;
  /** Fresh executor per run (disposed when the run settles). */
  createExecutor: () => Executor;
  fetchImpl?: typeof fetch;
  /** Pause between agent steps (default 500ms; tests pass 0). */
  settleMs?: number;
  /** Event-batch flush cadence (default 500ms). */
  flushMs?: number;
  /** Queue length that triggers an immediate flush (default 10). */
  flushBatchSize?: number;
  /** Shown as the run's machine label in every client (default 'local'). */
  machineLabel?: string;
  /**
   * Minimum gap between live-frame uploads (default 1000ms). The first frame
   * of a run always uploads immediately so the screen view fills fast.
   */
  frameMs?: number;
  /**
   * How often to poll the backend run status so a cancel issued from ANOTHER
   * device (a browser, a phone) aborts this machine's loop (default 2000ms;
   * 0 disables). The desktop window's own Cancel button aborts instantly via
   * IPC — this is the cross-device safety net.
   */
  cancelPollMs?: number;
}

export interface StartLocalRunInput {
  task: string;
  maxSteps?: number;
}

export type LocalRunListener = (event: AgentLoopEvent) => void;

/** Backend events-per-request hard cap (see runs.ts localEventsSchema). */
const MAX_EVENTS_PER_POST = 100;

const noop = (): void => undefined;

export class LocalRunManager {
  private readonly deps: LocalRunManagerDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly backendUrl: string;
  private readonly listeners = new Set<LocalRunListener>();

  private active: { runId: string; abort: AbortController; completion: Promise<void> } | null =
    null;

  // Event mirroring state (one run at a time, reset on each start()).
  private queue: BackendRunEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  /** Time-throttle for live-frame uploads (0 = upload the next one now). */
  private lastFrameAt = 0;
  /** Polls backend run status so a cross-device cancel aborts the local loop. */
  private cancelWatcher: ReturnType<typeof setInterval> | null = null;

  constructor(deps: LocalRunManagerDeps) {
    this.deps = deps;
    this.backendUrl = deps.backendUrl.replace(/\/+$/, '');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Subscribe to live loop events (UI mirroring). Returns an unsubscriber. */
  onEvent(cb: LocalRunListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get runningRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** Resolves when the current run (if any) has fully settled. */
  async whenIdle(): Promise<void> {
    await this.active?.completion;
  }

  /**
   * Start a local run: register it with the backend, open a proxied Coasty
   * session sized to the real screen, then drive the agent loop in the
   * background. Resolves with the backend run id as soon as the run is
   * registered so the UI can navigate to /runs/:id and watch the SSE stream.
   */
  async start(input: StartLocalRunInput): Promise<{ runId: string }> {
    if (this.active) {
      throw new Error('A local run is already in progress on this machine');
    }
    if (!this.deps.getToken()) {
      throw new Error('Not signed in: the desktop session token is missing');
    }
    const task = input.task.trim();
    if (!task) throw new Error('A non-empty task is required');
    const maxSteps = input.maxSteps ?? 25;

    this.queue = [];
    this.lastFrameAt = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const executor = this.deps.createExecutor();
    let runId: string | null = null;
    try {
      const run = await this.api<{ id: string }>('/api/local-runs', 'POST', {
        task,
        maxSteps,
        machineLabel: this.deps.machineLabel ?? 'local',
      });
      runId = run.id;

      const dims = await executor.dimensions();
      const session = await this.api<CreateSessionResponse>('/api/proxy/sessions', 'POST', {
        screenWidth: dims.width,
        screenHeight: dims.height,
      });

      const abort = new AbortController();
      const completion = this.runLoop(
        runId,
        session.session_id,
        executor,
        task,
        maxSteps,
        abort.signal,
      );
      this.active = { runId, abort, completion };
      // Watch for a cancel issued from any other client (the desktop window's
      // own Cancel aborts instantly via IPC; this catches phone/browser cancels).
      this.startCancelWatcher(runId, abort);
      return { runId };
    } catch (err) {
      // Could not even get the loop started. If the run row already exists,
      // close it out so no client is left staring at a forever-'running' run.
      if (runId) {
        const message = err instanceof Error ? err.message : String(err);
        this.queue.push(
          { type: 'error', data: { message } },
          { type: 'done', data: { status: 'failed', result: { passed: false, summary: message } } },
        );
        await this.flush(runId).catch(noop);
        await this.api(`/api/local-runs/${runId}`, 'PATCH', {
          status: 'failed',
          costCents: 0,
        }).catch(noop);
      }
      await executor.dispose().catch(noop);
      throw err;
    }
  }

  /** Abort the in-flight run (loop settles as 'aborted' → mirrored as 'cancelled'). */
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    await active.completion;
  }

  // ── cross-device cancel watcher ───────────────────────────────────────────────

  /**
   * Poll the backend run status; if it flips to `cancelled` (a cancel from
   * another client), abort this machine's loop so screen control stops too.
   * Best-effort: a failed poll never disrupts the run, and the first poll is one
   * interval out (the desktop window's own Cancel aborts instantly via IPC).
   */
  private startCancelWatcher(runId: string, abort: AbortController): void {
    const intervalMs = this.deps.cancelPollMs ?? 2000;
    this.stopCancelWatcher();
    if (intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (abort.signal.aborted) {
        this.stopCancelWatcher();
        return;
      }
      void (async () => {
        try {
          const run = await this.api<{ status?: string }>(`/api/runs/${runId}`, 'GET');
          if (run.status === 'cancelled' && !abort.signal.aborted) {
            abort.abort();
            this.stopCancelWatcher();
          }
        } catch {
          // A status poll is best-effort — never let it disrupt the run.
        }
      })();
    }, intervalMs);
    // Never keep the process alive just for the cancel poll.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as unknown as { unref(): void }).unref();
    }
    this.cancelWatcher = timer;
  }

  private stopCancelWatcher(): void {
    if (this.cancelWatcher) {
      clearInterval(this.cancelWatcher);
      this.cancelWatcher = null;
    }
  }

  // ── the loop (never throws; everything is mirrored + cleaned up) ───────────

  private async runLoop(
    runId: string,
    sessionId: string,
    executor: Executor,
    task: string,
    maxSteps: number,
    signal: AbortSignal,
  ): Promise<void> {
    let accumulatedCostCents = 0;
    let finishedMirrored = false;

    const mirror = (event: AgentLoopEvent): void => {
      this.emit(event);
      switch (event.type) {
        case 'step-start':
          break; // timeline noise
        case 'screenshot': {
          // A one-line marker keeps the durable timeline small...
          this.enqueue(runId, {
            type: 'text',
            data: { text: `step ${event.step + 1} screenshot captured` },
          });
          // ...and the actual frame is forwarded (throttled, best-effort) to the
          // ephemeral live-frame channel so every client's screen view updates.
          const now = Date.now();
          if (now - this.lastFrameAt >= (this.deps.frameMs ?? 1000)) {
            this.lastFrameAt = now;
            void this.uploadFrame(runId, event.base64, event.width, event.height);
          }
          break;
        }
        case 'prediction':
          accumulatedCostCents += event.costCents;
          this.enqueue(runId, {
            type: 'text',
            data: {
              text: event.reasoning && event.reasoning.trim() ? event.reasoning : 'thinking…',
            },
          });
          this.enqueue(runId, { type: 'billing', data: { cost_cents: accumulatedCostCents } });
          this.enqueue(runId, { type: 'step', data: { steps_completed: event.step + 1 } });
          break;
        case 'action':
          this.enqueue(runId, { type: 'tool_call', data: { action: event.action } });
          break;
        case 'action-error':
          this.enqueue(runId, { type: 'error', data: { message: event.error } });
          break;
        case 'finished': {
          finishedMirrored = true;
          this.enqueue(runId, {
            type: 'done',
            data: {
              status: mapOutcomeStatus(event.status),
              result: { passed: event.status === 'done', summary: event.reason ?? '' },
            },
          });
          break;
        }
      }
    };

    let outcome: AgentLoopOutcome;
    try {
      outcome = await runAgentLoop({
        screen: executor,
        predictStep: (input) => this.predict(sessionId, input),
        task,
        maxSteps,
        settleMs: this.deps.settleMs ?? 500,
        signal,
        onEvent: mirror,
      });
    } catch (err) {
      // The loop only throws on infrastructure failures (screenshot/predict
      // transport). Surface those as a failed run instead of dying silently.
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        status: 'fail',
        stepsUsed: 0,
        totalCostCents: accumulatedCostCents,
        reason: message,
      };
      if (!finishedMirrored) {
        this.emit({ type: 'finished', status: 'fail', stepsUsed: 0, reason: message });
        this.enqueue(runId, { type: 'error', data: { message } });
        this.enqueue(runId, {
          type: 'done',
          data: { status: 'failed', result: { passed: false, summary: message } },
        });
      }
    }

    // The loop has ended (done/failed/aborted) — stop watching for cancels.
    this.stopCancelWatcher();

    // Drain everything that is still queued — the 'done' event must land.
    await this.flush(runId).catch(noop);
    await this.api(`/api/local-runs/${runId}`, 'PATCH', {
      status: mapOutcomeStatus(outcome.status),
      costCents: accumulatedCostCents,
    }).catch(noop);
    await this.api(`/api/proxy/sessions/${sessionId}`, 'DELETE').catch(noop);
    await executor.dispose().catch(noop);
    this.active = null;
  }

  /** Best-effort upload of the latest screen frame for the live screen view. */
  private async uploadFrame(
    runId: string,
    base64: string,
    width: number,
    height: number,
  ): Promise<void> {
    try {
      await this.api(`/api/local-runs/${runId}/frame`, 'POST', { base64, width, height });
    } catch {
      // Live preview is best-effort; a dropped frame must never affect the run.
    }
  }

  private async predict(sessionId: string, input: PredictStepInput): Promise<PredictStepResult> {
    const res = await this.api<SessionPredictResponse>(
      `/api/proxy/sessions/${sessionId}/predict`,
      'POST',
      {
        screenshot: input.screenshotB64,
        instruction: input.instruction,
      },
    );
    return { status: res.status, actions: res.actions, reasoning: res.reasoning, usage: res.usage };
  }

  // ── event batching ──────────────────────────────────────────────────────────

  private enqueue(runId: string, event: BackendRunEvent): void {
    this.queue.push(event);
    if (this.queue.length >= (this.deps.flushBatchSize ?? 10)) {
      void this.flush(runId).catch(noop);
    } else if (!this.flushTimer) {
      const timer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush(runId).catch(noop);
      }, this.deps.flushMs ?? 500);
      // Never keep the process alive just for a pending mirror flush.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as unknown as { unref(): void }).unref();
      }
      this.flushTimer = timer;
    }
  }

  /**
   * Serialized drain of the queue: flushes are chained so batches reach the
   * backend in enqueue order even when triggers overlap.
   */
  private flush(runId: string): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushChain = this.flushChain.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_EVENTS_PER_POST);
        try {
          await this.api(`/api/local-runs/${runId}/events`, 'POST', { events: batch });
        } catch {
          // Mirroring is best-effort; a dropped batch must not kill the run.
          break;
        }
      }
    });
    return this.flushChain;
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private emit(event: AgentLoopEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken UI listener must never break the run.
      }
    }
  }

  private async api<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
    const token = this.deps.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(`${this.backendUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as { error?: { message?: string } };
        detail = parsed.error?.message ?? '';
      } catch {
        // non-JSON error body
      }
      throw new Error(
        `Backend ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Map a loop outcome onto the backend's local-run status vocabulary. */
function mapOutcomeStatus(
  status: AgentLoopOutcome['status'],
): 'succeeded' | 'cancelled' | 'failed' {
  if (status === 'done') return 'succeeded';
  if (status === 'aborted') return 'cancelled';
  return 'failed';
}
