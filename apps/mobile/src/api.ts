/**
 * Tiny typed client for the open-cowork backend (bearer session-token auth).
 *
 * The phone talks ONLY to apps/backend — the Coasty API key never reaches
 * this code. The session token lives in a module-level store so the fetch
 * layer stays framework-free; React state (who is signed in) lives in
 * src/auth.tsx on top of it.
 *
 * Mobile uses the REST polling fallback (`/events.json?after=N`) instead of
 * SSE: React Native's fetch lacks streaming response bodies.
 */
import { BACKEND_URL } from './config';

// ── DTOs (mirrors apps/backend/src/routes/*.ts) ─────────────────────────────

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

export interface RunEventDto {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RunEventsPage {
  events: RunEventDto[];
  done: boolean;
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

export interface MachineDto {
  id: string;
  display_name: string;
  status: string;
  os_type: 'linux' | 'windows';
  is_test: boolean;
  created_at: string;
}

export interface WalletDto {
  balanceCents: number;
  periodCostCents: number;
  period: string;
  monthSpendCents: number;
}

export interface ScreenshotDto {
  image_b64: string;
  width: number;
  height: number;
  captured_at: string;
}

// ── errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ── module-level session token store ────────────────────────────────────────

let currentToken: string | null = null;

export function setToken(token: string | null): void {
  currentToken = token;
}

export function getToken(): string | null {
  return currentToken;
}

// ── fetch layer ─────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the open-cowork backend');
  }

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

// ── endpoints ───────────────────────────────────────────────────────────────

export const api = {
  login: (email: string) =>
    request<{ token: string; user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: { email },
    }),
  me: () => request<{ user: SessionUser; monthSpendCents: number }>('/api/me'),
  wallet: () => request<WalletDto>('/api/wallet'),

  listRuns: () => request<{ runs: RunDto[] }>('/api/runs'),
  getRun: (id: string) => request<RunDto>(`/api/runs/${id}`),
  cancelRun: (id: string) =>
    request<RunDto>(`/api/runs/${id}/cancel`, { method: 'POST', body: {} }),
  resumeRun: (id: string, note?: string) =>
    request<RunDto>(`/api/runs/${id}/resume`, { method: 'POST', body: { note } }),
  /** REST polling fallback for the run event timeline (append-only cursor). */
  pollRunEvents: (id: string, after: number) =>
    request<RunEventsPage>(`/api/runs/${id}/events.json?after=${after}`),

  listWorkflowRuns: () => request<{ runs: WorkflowRunDto[] }>('/api/workflows/runs'),
  getWorkflowRun: (id: string) => request<WorkflowRunDto>(`/api/workflows/runs/${id}`),
  resumeWorkflowRun: (id: string, body: { approved: boolean; note?: string }) =>
    request<WorkflowRunDto>(`/api/workflows/runs/${id}/resume`, { method: 'POST', body }),

  listMachines: () => request<{ machines: MachineDto[] }>('/api/machines'),
  startMachine: (id: string) =>
    request<unknown>(`/api/machines/${id}/start`, { method: 'POST', body: {} }),
  stopMachine: (id: string) =>
    request<unknown>(`/api/machines/${id}/stop`, { method: 'POST', body: {} }),
  machineScreenshot: (id: string) => request<ScreenshotDto>(`/api/machines/${id}/screenshot`),
};
