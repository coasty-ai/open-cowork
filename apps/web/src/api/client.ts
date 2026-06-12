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
  balanceCents: number;
  periodCostCents: number;
  period: string;
  monthSpendCents: number;
}

export interface EstimateDto {
  kind: string;
  cents: number;
  breakdown: Record<string, unknown>;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface BackendClientOptions {
  baseUrl?: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

declare global {
  interface Window {
    cowork?: {
      platform: 'desktop' | 'web';
      backendUrl?: string;
      startLocalRun?: (input: { task: string; maxSteps?: number }) => Promise<{ runId: string }>;
      cancelLocalRun?: () => Promise<void>;
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

  constructor(opts: BackendClientOptions) {
    this.baseUrl = (opts.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
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
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the open-cowork backend', err);
    }
    if (!res.ok) {
      let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(
        res.status,
        body.error?.code ?? 'UNKNOWN',
        body.error?.message ?? `Request failed (${res.status})`,
        body.error?.details,
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
    return this.request(`/api/runs/${id}/resume`, { method: 'POST', body: JSON.stringify({ note }) });
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
  machineScreenshot(id: string): Promise<{ image_b64: string; width: number; height: number; captured_at: string }> {
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
    return this.request('/api/workflows/validate', { method: 'POST', body: JSON.stringify({ definition }) });
  }
  startWorkflowRun(
    workflowId: string,
    body: { inputs?: Record<string, unknown>; machineId?: string; budgetCents: number; confirmCostCents: number },
  ): Promise<WorkflowRunDto> {
    return this.request(`/api/workflows/${workflowId}/runs`, { method: 'POST', body: JSON.stringify(body) });
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
