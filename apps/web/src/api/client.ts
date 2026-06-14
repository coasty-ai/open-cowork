/**
 * Typed client for the open-cowork backend. Clients hold ONLY a short-lived
 * session token — the Coasty key never reaches this code (see SECURITY.md).
 * The base URL is same-origin by default (vite dev/preview proxy '/api'); the
 * desktop shell injects an absolute URL via window.cowork.backendUrl.
 */

export interface SessionUser {
  id: string;
  email: string;
  budgetCents: number;
}

export interface RunDto {
  id: string;
  kind: 'coasty' | 'local';
  machineId: string | null;
  task: string;
  status: string;
  cuaVersion: string;
  maxSteps: number;
  budgetCents: number;
  costCents: number;
  stepsCompleted: number;
  result: { passed?: boolean; summary?: string } | null;
  error: { code?: string; message?: string } | null;
  awaitingHumanReason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MachineDto {
  id: string;
  display_name: string;
  status: string;
  os_type: 'linux' | 'windows';
  is_test: boolean;
  created_at: string;
}

export interface WorkflowDto {
  id: string;
  name: string;
  slug: string;
  version: number;
  definition: Record<string, unknown>;
  description: string | null;
  status: string;
}

export interface WorkflowRunDto {
  id: string;
  workflowId: string | null;
  status: string;
  budgetCents: number;
  spentCents: number;
  awaitingStepId: string | null;
  awaitingReason?: string | null;
  output?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface WalletDto {
  /** Null when the Coasty `usage` scope is missing or the endpoint is down. */
  balanceCents: number | null;
  periodCostCents: number | null;
  period: string | null;
  monthSpendCents: number;
  walletAvailable?: boolean;
  walletUnavailableReason?: string;
}

export interface EstimateDto {
  kind: string;
  cents: number;
  breakdown: Record<string, unknown>;
}

/**
 * Whether a Coasty API key is configured on the backend, and in what mode.
 * Carries NO secret — only the derived mode and where the active key came from.
 * `demoMode` means the app is running on the bundled local sandbox (no real key).
 */
export interface CoastyKeyStatus {
  configured: boolean;
  mode: 'live' | 'test' | 'legacy' | null;
  demoMode: boolean;
  source: 'runtime' | 'env' | 'demo';
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Coasty request id, when the failure originated upstream (for support). */
    readonly requestId?: string,
    /** Coasty's actionable hint for resolving this error, when it provides one. */
    readonly suggestion?: string,
  ) {
    super(message);
  }
}

/**
 * True when an error means the backend itself is unreachable — either the dev
 * proxy answered with our `503 BACKEND_UNREACHABLE` (web, backend not up) or the
 * fetch never connected at all (desktop talking directly to the backend, status
 * 0 `NETWORK_ERROR`). Lets the UI show a "start the backend" hint instead of a
 * generic failure, and lets callers back off polling.
 */
export function isBackendUnreachable(err: unknown): boolean {
  return (
    err instanceof ApiError && (err.code === 'NETWORK_ERROR' || err.code === 'BACKEND_UNREACHABLE')
  );
}

/**
 * A human-readable, debuggable rendering of an error for the UI: the message,
 * the stable code, any offending fields, and the upstream request id. Turns a
 * terse "Could not create run." into something actionable.
 */
export function formatApiError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : 'Unexpected error';
  }
  // Connectivity failures already carry a friendly, actionable message — return
  // it bare, without an error-code tag or request id to clutter the banner.
  if (isBackendUnreachable(err)) return err.message;
  const parts = [err.message];
  // Coasty's own suggestion is the most actionable thing we can show — surface
  // it right after the message (e.g. why a run couldn't be created).
  if (err.suggestion && !err.message.includes(err.suggestion)) {
    parts.push(err.suggestion.endsWith('.') ? err.suggestion : `${err.suggestion}.`);
  }
  if (err.code && err.code !== 'UNKNOWN' && !err.message.includes(err.code)) {
    parts.push(`[${err.code}]`);
  }
  // Surface offending field paths from a validation error's details.
  if (Array.isArray(err.details)) {
    const fields = err.details
      .map((d) =>
        d && typeof d === 'object' && 'path' in d ? String((d as { path: unknown }).path) : null,
      )
      .filter((p): p is string => Boolean(p));
    if (fields.length > 0) parts.push(`(fields: ${[...new Set(fields)].join(', ')})`);
  }
  if (err.requestId) parts.push(`(request ${err.requestId})`);
  return parts.join(' ');
}

export interface BackendClientOptions {
  baseUrl?: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
  /**
   * Called when an authenticated request is rejected with 401 — the session
   * token is no longer valid (expired, or the backend restarted and forgot it,
   * which happens whenever the session secret is auto-generated). The app
   * clears the session and returns to login. Not fired for the login route.
   */
  onUnauthorized?: () => void;
}

/** BYO-LLM provider kinds the desktop supports (mirrors @open-cowork/llm). */
export type ProviderKind = 'coasty' | 'openai' | 'openai-compatible' | 'openrouter';

/** Secret-free provider status from the desktop (never carries the key value). */
export interface CoworkProviderStatus {
  kind: ProviderKind;
  model: string | null;
  baseUrl?: string;
  label?: string;
  vision?: boolean | 'unknown';
  hasKey: boolean;
  /** True when no BYO provider is configured → Coasty default. */
  isDefault: boolean;
  /** Whether OS-backed key encryption is available on this machine. */
  secureStorage: boolean;
}

export interface CoworkModelInfo {
  id: string;
  label: string;
  vision: boolean | 'unknown';
  tools?: boolean;
}

/** Config for listing models / testing a provider before saving it. */
export interface CoworkProviderProbe {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Config to persist a BYO provider. */
export interface CoworkSetProvider {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  vision?: boolean | 'unknown';
  visionOverride?: boolean;
  label?: string;
  apiKey?: string;
}

export type CoworkListModelsResult =
  | { ok: true; models: CoworkModelInfo[] }
  | { ok: false; code: string; message: string };

export interface CoworkHealthResult {
  ok: boolean;
  detail?: string;
  code?: string;
}

declare global {
  interface Window {
    cowork?: {
      platform: 'desktop' | 'web';
      backendUrl?: string;
      startLocalRun?: (input: {
        task: string;
        maxSteps?: number;
        /** Electron display id of the screen to run on (from `listScreens`). */
        displayId?: number;
      }) => Promise<{ runId: string }>;
      cancelLocalRun?: () => Promise<void>;
      /** The monitors a local run can target (for the screen selector). */
      listScreens?: () => Promise<
        { id: number; label: string; primary: boolean; current: boolean }[]
      >;
      // ── BYO LLM provider (desktop only) ──
      getProvider?: () => Promise<CoworkProviderStatus>;
      setProvider?: (input: CoworkSetProvider) => Promise<CoworkProviderStatus>;
      clearProvider?: () => Promise<CoworkProviderStatus>;
      listProviderModels?: (input: CoworkProviderProbe) => Promise<CoworkListModelsResult>;
      testProvider?: (input: CoworkProviderProbe) => Promise<CoworkHealthResult>;
    };
  }
}

/** Resolve the backend base URL for the current host (web vs desktop shell). */
export function defaultBaseUrl(): string {
  if (typeof window !== 'undefined' && window.cowork?.backendUrl) return window.cowork.backendUrl;
  return '';
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized: (() => void) | undefined;

  constructor(opts: BackendClientOptions) {
    this.baseUrl = (opts.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onUnauthorized = opts.onUnauthorized;
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  authHeaders(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Cannot reach the open-cowork backend — is it running? Start it with `pnpm dev` (or `pnpm desktop`).',
        err,
      );
    }
    if (!res.ok) {
      let body: {
        error?: {
          code?: string;
          message?: string;
          details?: unknown;
          requestId?: string;
          suggestion?: string;
        };
      } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // non-JSON error body
      }
      // A stale/invalid SESSION token: clear it and bounce to login. (Skip the
      // login route, where a 401 is a normal credential rejection — and skip a
      // rejected COASTY key, which surfaces as 401 INVALID_API_KEY: that means
      // "fix your Coasty key", not "your session expired", so we keep the
      // session and let the UI prompt re-setup.)
      if (
        res.status === 401 &&
        !path.startsWith('/api/auth/') &&
        body.error?.code !== 'INVALID_API_KEY'
      ) {
        this.onUnauthorized?.();
      }
      throw new ApiError(
        res.status,
        body.error?.code ?? 'UNKNOWN',
        body.error?.message ?? `Request failed (${res.status})`,
        body.error?.details,
        body.error?.requestId,
        body.error?.suggestion,
      );
    }
    return (await res.json()) as T;
  }

  // auth
  login(email: string): Promise<{ token: string; user: SessionUser }> {
    return this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email }) });
  }
  me(): Promise<{ user: SessionUser; monthSpendCents: number }> {
    return this.request('/api/me');
  }
  wallet(): Promise<WalletDto> {
    return this.request('/api/wallet');
  }
  estimate(body: Record<string, unknown>): Promise<EstimateDto> {
    return this.request('/api/estimate', { method: 'POST', body: JSON.stringify(body) });
  }

  // Coasty API key configuration. The key is write-only — the backend never
  // returns it; the status carries only the derived mode (see CoastyKeyStatus).
  coastyKeyStatus(): Promise<CoastyKeyStatus> {
    return this.request('/api/config/coasty-key');
  }
  setCoastyKey(apiKey: string): Promise<CoastyKeyStatus & { ok: true }> {
    return this.request('/api/config/coasty-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });
  }
  clearCoastyKey(): Promise<CoastyKeyStatus> {
    return this.request('/api/config/coasty-key', { method: 'DELETE' });
  }

  // runs
  createRun(body: {
    machineId: string;
    task: string;
    cuaVersion?: string;
    maxSteps?: number;
    budgetCents?: number;
    confirmCostCents: number;
  }): Promise<RunDto> {
    return this.request('/api/runs', { method: 'POST', body: JSON.stringify(body) });
  }
  listRuns(): Promise<{ runs: RunDto[] }> {
    return this.request('/api/runs');
  }
  getRun(id: string): Promise<RunDto> {
    return this.request(`/api/runs/${id}`);
  }
  cancelRun(id: string): Promise<RunDto> {
    return this.request(`/api/runs/${id}/cancel`, { method: 'POST', body: '{}' });
  }
  resumeRun(id: string, note?: string): Promise<RunDto> {
    return this.request(`/api/runs/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  }
  /** Latest live screen frame for a LOCAL run (base64 PNG), or nulls if none yet. */
  localRunFrame(id: string): Promise<{
    base64: string | null;
    width: number | null;
    height: number | null;
    capturedAt: string | null;
  }> {
    return this.request(`/api/local-runs/${id}/frame`);
  }

  // machines
  listMachines(): Promise<{ machines: MachineDto[] }> {
    return this.request('/api/machines');
  }
  createMachine(body: {
    displayName: string;
    osType?: 'linux' | 'windows';
    ttlMinutes?: number;
    confirmCostCents: number;
  }): Promise<{ machine: MachineDto }> {
    return this.request('/api/machines', { method: 'POST', body: JSON.stringify(body) });
  }
  startMachine(id: string): Promise<unknown> {
    return this.request(`/api/machines/${id}/start`, { method: 'POST', body: '{}' });
  }
  stopMachine(id: string): Promise<unknown> {
    return this.request(`/api/machines/${id}/stop`, { method: 'POST', body: '{}' });
  }
  terminateMachine(id: string): Promise<unknown> {
    return this.request(`/api/machines/${id}`, { method: 'DELETE' });
  }
  snapshotMachine(id: string): Promise<unknown> {
    return this.request(`/api/machines/${id}/snapshot`, { method: 'POST', body: '{}' });
  }
  machineScreenshot(
    id: string,
  ): Promise<{ image_b64: string; width: number; height: number; captured_at: string }> {
    return this.request(`/api/machines/${id}/screenshot`);
  }

  // workflows
  listWorkflows(): Promise<{ workflows: WorkflowDto[] }> {
    return this.request('/api/workflows');
  }
  getWorkflow(id: string): Promise<WorkflowDto> {
    return this.request(`/api/workflows/${id}`);
  }
  createWorkflow(body: {
    name: string;
    slug: string;
    definition: Record<string, unknown>;
    description?: string;
  }): Promise<WorkflowDto> {
    return this.request('/api/workflows', { method: 'POST', body: JSON.stringify(body) });
  }
  updateWorkflow(id: string, body: Record<string, unknown>): Promise<WorkflowDto> {
    return this.request(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  validateWorkflow(definition: Record<string, unknown>): Promise<{
    valid: boolean;
    issues: { path: string; code: string; message: string }[];
    estimate: { typicalCents: number; worstCaseCents: number } | null;
  }> {
    return this.request('/api/workflows/validate', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    });
  }
  startWorkflowRun(
    workflowId: string,
    body: {
      inputs?: Record<string, unknown>;
      machineId?: string;
      budgetCents: number;
      confirmCostCents: number;
    },
  ): Promise<WorkflowRunDto> {
    return this.request(`/api/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  listWorkflowRuns(): Promise<{ runs: WorkflowRunDto[] }> {
    return this.request('/api/workflows/runs');
  }
  getWorkflowRun(id: string): Promise<WorkflowRunDto> {
    return this.request(`/api/workflows/runs/${id}`);
  }
  cancelWorkflowRun(id: string): Promise<WorkflowRunDto> {
    return this.request(`/api/workflows/runs/${id}/cancel`, { method: 'POST', body: '{}' });
  }
  resumeWorkflowRun(id: string, approved: boolean, note?: string): Promise<WorkflowRunDto> {
    return this.request(`/api/workflows/runs/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ approved, note }),
    });
  }
}
