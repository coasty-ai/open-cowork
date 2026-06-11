/**
 * Typed Coasty API client. Isomorphic: injectable `fetch`, no Node APIs.
 *
 * Retry policy: GET and DELETE requests are retried on retryable failures
 * (network, timeout, 429, 5xx) with exponential backoff + full jitter, honoring
 * `Retry-After`. POST/PUT/PATCH are retried ONLY when the caller supplied an
 * `Idempotency-Key` — without one, a retried create could double-execute a
 * billable action, which is never acceptable.
 */
import type {
  CreateMachineRequest,
  CreateMachineResponse,
  CreateRunRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorkflowRequest,
  GroundRequest,
  GroundResponse,
  ListResponse,
  Machine,
  MachineActionRequest,
  MachineActionResponse,
  MachineActionsBatchRequest,
  MachineActionsBatchResponse,
  MachineBrowserOp,
  MachineConnectionDetails,
  MachineFileOp,
  MachineLifecycleResponse,
  MachinePricingResponse,
  MachineScreenshotResponse,
  MachineTerminalRequest,
  MachineTerminalResponse,
  ModelsResponse,
  ParseResponse,
  PredictRequest,
  PredictResponse,
  ResumeRunRequest,
  ResumeWorkflowRunRequest,
  Run,
  RunEvent,
  RunStatus,
  SessionInfoResponse,
  SessionPredictRequest,
  SessionPredictResponse,
  SnapshotResponse,
  StartWorkflowRunRequest,
  UpdateWorkflowRequest,
  UsageResponse,
  Workflow,
  WorkflowRun,
} from './types';
import { CoastyNetworkError, CoastyTimeoutError, coastyErrorFromResponse } from './errors';
import { withRetry, abortableSleep, type RetryOptions } from './retry';
import { parseSseStream } from './sse';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoastyClientOptions {
  /** e.g. `https://coasty.ai/v1` or the mock `http://127.0.0.1:4010/v1`. */
  baseUrl: string;
  /** API key. Backend-only — never construct a keyed client in browser code. */
  apiKey: string;
  /** Injectable fetch (tests, polyfills). Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Per-request timeout. Default 60s. */
  timeoutMs?: number;
  /** Retry tuning; see module docs for the policy. */
  retry?: Pick<RetryOptions, 'maxAttempts' | 'baseMs' | 'maxMs' | 'sleep' | 'random'>;
  /** Extra headers attached to every request. */
  defaultHeaders?: Record<string, string>;
}

export interface RequestExtras {
  /** Enables safe retries on POST and dedupes on the server (24h window). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Resume after this sequence number (sent as `Last-Event-ID`). */
  lastEventId?: number;
  /** Max automatic reconnect attempts after a dropped stream. Default 10. */
  maxReconnects?: number;
  /** Injectable sleep between reconnects (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface InternalRequestOptions extends RequestExtras {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class CoastyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryOpts: CoastyClientOptions['retry'];
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: CoastyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retryOpts = opts.retry;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  // ── transport ───────────────────────────────────────────────────────────────

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = Object.entries(query)
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      if (params.length > 0) url += `?${params.join('&')}`;
    }
    return url;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...extra,
    };
  }

  /** One HTTP attempt: timeout, error-envelope mapping, JSON parse. */
  private async attempt<T>(opts: InternalRequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new CoastyTimeoutError(this.timeoutMs)), this.timeoutMs);
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (opts.signal?.aborted) controller.abort(opts.signal.reason);

    const headers = this.headers(
      opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof CoastyTimeoutError) throw err;
      if (controller.signal.aborted && controller.signal.reason instanceof CoastyTimeoutError) {
        throw controller.signal.reason;
      }
      if (opts.signal?.aborted) throw err;
      throw new CoastyNetworkError(`Network error calling ${opts.method} ${opts.path}`, err);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw coastyErrorFromResponse(res.status, body, res.headers.get('Retry-After'));
    }
    return (await res.json()) as T;
  }

  /** Request with the retry policy described in the module docs. */
  private request<T>(opts: InternalRequestOptions): Promise<T> {
    const safeToRetry =
      opts.method === 'GET' || opts.method === 'DELETE' || opts.idempotencyKey !== undefined;
    if (!safeToRetry) return this.attempt<T>(opts);
    return withRetry(() => this.attempt<T>(opts), {
      ...this.retryOpts,
      signal: opts.signal,
    });
  }

  // ── core inference ──────────────────────────────────────────────────────────

  predict(req: PredictRequest, extras?: RequestExtras): Promise<PredictResponse> {
    return this.request({ method: 'POST', path: '/predict', body: req, ...extras });
  }

  createSession(req: CreateSessionRequest = {}, extras?: RequestExtras): Promise<CreateSessionResponse> {
    return this.request({ method: 'POST', path: '/sessions', body: req, ...extras });
  }

  sessionPredict(
    sessionId: string,
    req: SessionPredictRequest,
    extras?: RequestExtras,
  ): Promise<SessionPredictResponse> {
    return this.request({
      method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}/predict`,
      body: req,
      ...extras,
    });
  }

  resetSession(sessionId: string, extras?: RequestExtras): Promise<{ status: string; session_id: string }> {
    return this.request({ method: 'POST', path: `/sessions/${encodeURIComponent(sessionId)}/reset`, body: {}, ...extras });
  }

  getSession(sessionId: string, extras?: RequestExtras): Promise<SessionInfoResponse> {
    return this.request({ method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}`, ...extras });
  }

  listSessions(extras?: RequestExtras): Promise<{ sessions: SessionInfoResponse[] }> {
    return this.request({ method: 'GET', path: '/sessions', ...extras });
  }

  deleteSession(sessionId: string, extras?: RequestExtras): Promise<{ status: string; session_id: string }> {
    return this.request({ method: 'DELETE', path: `/sessions/${encodeURIComponent(sessionId)}`, ...extras });
  }

  ground(req: GroundRequest, extras?: RequestExtras): Promise<GroundResponse> {
    return this.request({ method: 'POST', path: '/ground', body: req, ...extras });
  }

  parse(code: string, extras?: RequestExtras): Promise<ParseResponse> {
    return this.request({ method: 'POST', path: '/parse', body: { code }, ...extras });
  }

  models(extras?: RequestExtras): Promise<ModelsResponse> {
    return this.request({ method: 'GET', path: '/models', ...extras });
  }

  usage(period?: string, extras?: RequestExtras): Promise<UsageResponse> {
    return this.request({ method: 'GET', path: '/usage', query: { period }, ...extras });
  }

  // ── runs ────────────────────────────────────────────────────────────────────

  createRun(req: CreateRunRequest, extras?: RequestExtras): Promise<Run> {
    return this.request({ method: 'POST', path: '/runs', body: req, ...extras });
  }

  listRuns(
    opts: { status?: RunStatus; limit?: number } = {},
    extras?: RequestExtras,
  ): Promise<ListResponse<Run>> {
    return this.request({ method: 'GET', path: '/runs', query: { status: opts.status, limit: opts.limit }, ...extras });
  }

  getRun(runId: string, extras?: RequestExtras): Promise<Run> {
    return this.request({ method: 'GET', path: `/runs/${encodeURIComponent(runId)}`, ...extras });
  }

  cancelRun(runId: string, extras?: RequestExtras): Promise<Run> {
    return this.request({ method: 'POST', path: `/runs/${encodeURIComponent(runId)}/cancel`, body: {}, ...extras });
  }

  resumeRun(runId: string, req: ResumeRunRequest = {}, extras?: RequestExtras): Promise<Run> {
    return this.request({ method: 'POST', path: `/runs/${encodeURIComponent(runId)}/resume`, body: req, ...extras });
  }

  /** Stream run events with automatic reconnect via `Last-Event-ID`. */
  streamRunEvents(runId: string, opts: StreamOptions = {}): AsyncGenerator<RunEvent> {
    return this.streamEvents(`/runs/${encodeURIComponent(runId)}/events`, opts);
  }

  // ── workflows ───────────────────────────────────────────────────────────────

  createWorkflow(req: CreateWorkflowRequest, extras?: RequestExtras): Promise<Workflow> {
    return this.request({ method: 'POST', path: '/workflows', body: req, ...extras });
  }

  listWorkflows(opts: { limit?: number } = {}, extras?: RequestExtras): Promise<ListResponse<Workflow>> {
    return this.request({ method: 'GET', path: '/workflows', query: { limit: opts.limit }, ...extras });
  }

  getWorkflow(workflowId: string, extras?: RequestExtras): Promise<Workflow> {
    return this.request({ method: 'GET', path: `/workflows/${encodeURIComponent(workflowId)}`, ...extras });
  }

  updateWorkflow(workflowId: string, req: UpdateWorkflowRequest, extras?: RequestExtras): Promise<Workflow> {
    return this.request({ method: 'PUT', path: `/workflows/${encodeURIComponent(workflowId)}`, body: req, ...extras });
  }

  deleteWorkflow(workflowId: string, extras?: RequestExtras): Promise<Workflow | { status: string }> {
    return this.request({ method: 'DELETE', path: `/workflows/${encodeURIComponent(workflowId)}`, ...extras });
  }

  startWorkflowRun(
    workflowId: string,
    req: StartWorkflowRunRequest = {},
    extras?: RequestExtras,
  ): Promise<WorkflowRun> {
    return this.request({
      method: 'POST',
      path: `/workflows/${encodeURIComponent(workflowId)}/runs`,
      body: req,
      ...extras,
    });
  }

  startAdhocWorkflowRun(req: StartWorkflowRunRequest, extras?: RequestExtras): Promise<WorkflowRun> {
    return this.request({ method: 'POST', path: '/workflows/runs', body: req, ...extras });
  }

  listWorkflowRuns(
    opts: { workflow_id?: string; limit?: number } = {},
    extras?: RequestExtras,
  ): Promise<ListResponse<WorkflowRun>> {
    return this.request({
      method: 'GET',
      path: '/workflows/runs',
      query: { workflow_id: opts.workflow_id, limit: opts.limit },
      ...extras,
    });
  }

  getWorkflowRun(workflowRunId: string, extras?: RequestExtras): Promise<WorkflowRun> {
    return this.request({ method: 'GET', path: `/workflows/runs/${encodeURIComponent(workflowRunId)}`, ...extras });
  }

  cancelWorkflowRun(workflowRunId: string, extras?: RequestExtras): Promise<WorkflowRun> {
    return this.request({
      method: 'POST',
      path: `/workflows/runs/${encodeURIComponent(workflowRunId)}/cancel`,
      body: {},
      ...extras,
    });
  }

  resumeWorkflowRun(
    workflowRunId: string,
    req: ResumeWorkflowRunRequest,
    extras?: RequestExtras,
  ): Promise<WorkflowRun> {
    return this.request({
      method: 'POST',
      path: `/workflows/runs/${encodeURIComponent(workflowRunId)}/resume`,
      body: req,
      ...extras,
    });
  }

  streamWorkflowRunEvents(workflowRunId: string, opts: StreamOptions = {}): AsyncGenerator<RunEvent> {
    return this.streamEvents(`/workflows/runs/${encodeURIComponent(workflowRunId)}/events`, opts);
  }

  // ── machines ────────────────────────────────────────────────────────────────

  createMachine(req: CreateMachineRequest, extras?: RequestExtras): Promise<CreateMachineResponse> {
    return this.request({ method: 'POST', path: '/machines', body: req, ...extras });
  }

  listMachines(opts: { limit?: number } = {}, extras?: RequestExtras): Promise<ListResponse<Machine> | { machines: Machine[] }> {
    return this.request({ method: 'GET', path: '/machines', query: { limit: opts.limit }, ...extras });
  }

  getMachine(machineId: string, extras?: RequestExtras): Promise<Machine | { machine: Machine }> {
    return this.request({ method: 'GET', path: `/machines/${encodeURIComponent(machineId)}`, ...extras });
  }

  machinePricing(extras?: RequestExtras): Promise<MachinePricingResponse> {
    return this.request({ method: 'GET', path: '/machines/pricing', ...extras });
  }

  startMachine(machineId: string, extras?: RequestExtras): Promise<MachineLifecycleResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/start`, body: {}, ...extras });
  }

  stopMachine(machineId: string, extras?: RequestExtras): Promise<MachineLifecycleResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/stop`, body: {}, ...extras });
  }

  restartMachine(machineId: string, extras?: RequestExtras): Promise<MachineLifecycleResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/restart`, body: {}, ...extras });
  }

  terminateMachine(machineId: string, extras?: RequestExtras): Promise<MachineLifecycleResponse> {
    return this.request({ method: 'DELETE', path: `/machines/${encodeURIComponent(machineId)}`, ...extras });
  }

  patchMachineTtl(machineId: string, ttlMinutes: number, extras?: RequestExtras): Promise<Machine | MachineLifecycleResponse> {
    return this.request({
      method: 'PATCH',
      path: `/machines/${encodeURIComponent(machineId)}`,
      body: { ttl_minutes: ttlMinutes },
      ...extras,
    });
  }

  snapshotMachine(machineId: string, extras?: RequestExtras): Promise<SnapshotResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/snapshot`, body: {}, ...extras });
  }

  machineScreenshot(machineId: string, extras?: RequestExtras): Promise<MachineScreenshotResponse> {
    return this.request({ method: 'GET', path: `/machines/${encodeURIComponent(machineId)}/screenshot`, ...extras });
  }

  machineConnection(machineId: string, extras?: RequestExtras): Promise<MachineConnectionDetails> {
    return this.request({ method: 'GET', path: `/machines/${encodeURIComponent(machineId)}/connection`, ...extras });
  }

  machineAction(machineId: string, req: MachineActionRequest, extras?: RequestExtras): Promise<MachineActionResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/actions`, body: req, ...extras });
  }

  machineActionsBatch(
    machineId: string,
    req: MachineActionsBatchRequest,
    extras?: RequestExtras,
  ): Promise<MachineActionsBatchResponse> {
    return this.request({
      method: 'POST',
      path: `/machines/${encodeURIComponent(machineId)}/actions/batch`,
      body: req,
      ...extras,
    });
  }

  machineBrowserOp(
    machineId: string,
    op: MachineBrowserOp,
    parameters: Record<string, unknown> = {},
    extras?: RequestExtras,
  ): Promise<MachineActionResponse> {
    return this.request({
      method: 'POST',
      path: `/machines/${encodeURIComponent(machineId)}/browser/${op}`,
      body: { parameters },
      ...extras,
    });
  }

  machineTerminal(machineId: string, req: MachineTerminalRequest, extras?: RequestExtras): Promise<MachineTerminalResponse> {
    return this.request({ method: 'POST', path: `/machines/${encodeURIComponent(machineId)}/terminal`, body: req, ...extras });
  }

  machineFileOp(
    machineId: string,
    op: MachineFileOp,
    parameters: Record<string, unknown>,
    extras?: RequestExtras,
  ): Promise<Record<string, unknown>> {
    return this.request({
      method: 'POST',
      path: `/machines/${encodeURIComponent(machineId)}/files/${op}`,
      body: { parameters },
      ...extras,
    });
  }

  // ── SSE streaming ───────────────────────────────────────────────────────────

  /**
   * Open an SSE stream and yield parsed {@link RunEvent}s. On a dropped
   * connection, reconnects with `Last-Event-ID` set to the last seen seq so no
   * event is lost or duplicated. Ends after a `done` event, on abort, or when
   * reconnect attempts are exhausted.
   */
  private async *streamEvents(path: string, opts: StreamOptions): AsyncGenerator<RunEvent> {
    const { signal, maxReconnects = 10, sleep = abortableSleep } = opts;
    let cursor = opts.lastEventId ?? 0;
    let reconnects = 0;

    for (;;) {
      if (signal?.aborted) return;
      let res: Response;
      try {
        res = await this.fetchImpl(this.buildUrl(path), {
          method: 'GET',
          headers: this.headers({
            Accept: 'text/event-stream',
            ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) return;
        if (reconnects++ >= maxReconnects) {
          throw new CoastyNetworkError(`SSE stream failed after ${maxReconnects} reconnects`, err);
        }
        await sleep(Math.min(500 * 2 ** reconnects, 5_000), signal);
        continue;
      }

      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw coastyErrorFromResponse(res.status, body, res.headers.get('Retry-After'));
      }
      if (!res.body) {
        throw new CoastyNetworkError('SSE response had no body');
      }

      let sawDone = false;
      try {
        for await (const evt of parseSseStream(res.body)) {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(evt.data) as Record<string, unknown>;
          } catch {
            data = { raw: evt.data };
          }
          const seq = evt.id !== undefined ? Number(evt.id) : cursor + 1;
          if (seq <= cursor) continue; // defensive de-dupe on replay overlap
          cursor = seq;
          const event: RunEvent = {
            seq,
            type: (evt.event ?? 'message') as RunEvent['type'],
            data,
          };
          yield event;
          if (event.type === 'done') {
            sawDone = true;
            break;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (reconnects++ >= maxReconnects) {
          throw new CoastyNetworkError(`SSE stream failed after ${maxReconnects} reconnects`, err);
        }
        await sleep(Math.min(500 * 2 ** reconnects, 5_000), signal);
        continue;
      }

      if (sawDone || signal?.aborted) return;
      // Stream ended without `done` (server drop): reconnect from cursor.
      if (reconnects++ >= maxReconnects) return;
      await sleep(Math.min(500 * 2 ** reconnects, 5_000), signal);
    }
  }
}
