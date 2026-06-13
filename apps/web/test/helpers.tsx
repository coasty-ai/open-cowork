/**
 * Shared test helpers: a stub BackendClient factory (mirrors the pattern in
 * pages.test.tsx) and an SSE-stream fetch fake so SSE-driven pages/hooks can be
 * exercised fully offline.
 */
import { vi } from 'vitest';
import type { BackendClient } from '../src/api/client';

export type Stub = Partial<Record<keyof BackendClient, unknown>>;

/**
 * Build a stub BackendClient. url()/authHeaders() are real-ish (used by useSse
 * + SettingsPage); every method is a vi.fn with a sane default that overrides
 * can replace.
 */
export function stubClient(overrides: Stub = {}): BackendClient {
  const base = {
    url: (p: string) => p,
    authHeaders: () => ({ Authorization: 'Bearer cwk_t' }),
    login: vi.fn(async (email: string) => ({
      token: 'cwk_test_token',
      user: { id: 'u1', email, budgetCents: 500 },
    })),
    me: vi.fn(async () => ({
      user: { id: 'u1', email: 'a@b.c', budgetCents: 500 },
      monthSpendCents: 0,
    })),
    wallet: vi.fn(async () => ({
      balanceCents: 9300,
      periodCostCents: 0,
      period: '2026-06',
      monthSpendCents: 12,
    })),
    estimate: vi.fn(async () => ({ kind: 'run', cents: 125, breakdown: {} })),
    // Default: a key IS configured, so gated pages show normal content. Tests
    // that exercise the gated/demo state override this with a demo status.
    coastyKeyStatus: vi.fn(async () => ({
      configured: true,
      mode: 'test' as 'live' | 'test' | 'legacy' | null,
      demoMode: false,
      source: 'env' as 'runtime' | 'env' | 'demo',
    })),
    setCoastyKey: vi.fn(async () => ({
      ok: true as const,
      configured: true,
      mode: 'test' as 'live' | 'test' | 'legacy' | null,
      demoMode: false,
      source: 'runtime' as 'runtime' | 'env' | 'demo',
    })),
    clearCoastyKey: vi.fn(async () => ({
      configured: false,
      mode: null as 'live' | 'test' | 'legacy' | null,
      demoMode: true,
      source: 'demo' as 'runtime' | 'env' | 'demo',
    })),
    listMachines: vi.fn(async () => ({
      machines: [
        {
          id: 'm1',
          display_name: 'worker-1',
          status: 'running',
          os_type: 'linux',
          is_test: true,
          created_at: '',
        },
      ],
    })),
    listRuns: vi.fn(async () => ({ runs: [] })),
    getRun: vi.fn(async () => makeRun()),
    createRun: vi.fn(async () => makeRun({ id: 'r_new', status: 'queued' })),
    cancelRun: vi.fn(async () => makeRun({ status: 'cancelled' })),
    resumeRun: vi.fn(async () => makeRun({ status: 'running' })),
    localRunFrame: vi.fn(async () => ({
      base64: null as string | null,
      width: null as number | null,
      height: null as number | null,
      capturedAt: null as string | null,
    })),
    createMachine: vi.fn(async () => ({ machine: { id: 'm2' } })),
    startMachine: vi.fn(async () => ({})),
    stopMachine: vi.fn(async () => ({})),
    terminateMachine: vi.fn(async () => ({})),
    snapshotMachine: vi.fn(async () => ({})),
    machineScreenshot: vi.fn(async () => ({
      image_b64: 'AAAA',
      width: 100,
      height: 100,
      captured_at: '2026-06-12T00:00:00Z',
    })),
    listWorkflows: vi.fn(async () => ({ workflows: [] })),
    getWorkflow: vi.fn(async () => makeWorkflow()),
    createWorkflow: vi.fn(async () => makeWorkflow({ id: 'wf_new' })),
    updateWorkflow: vi.fn(async () => makeWorkflow({ version: 2 })),
    validateWorkflow: vi.fn(async () => ({
      valid: true,
      issues: [],
      estimate: { typicalCents: 80, worstCaseCents: 200 },
    })),
    startWorkflowRun: vi.fn(async () => makeWorkflowRun({ id: 'wfr_new' })),
    listWorkflowRuns: vi.fn(async () => ({ runs: [] })),
    getWorkflowRun: vi.fn(async () => makeWorkflowRun()),
    cancelWorkflowRun: vi.fn(async () => makeWorkflowRun({ status: 'cancelled' })),
    resumeWorkflowRun: vi.fn(async () => makeWorkflowRun({ status: 'running' })),
    ...overrides,
  };
  return base as unknown as BackendClient;
}

type RunDtoLike = ReturnType<typeof makeRun>;

export function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    kind: 'coasty' as const,
    machineId: 'm1',
    task: 'Download the invoices',
    status: 'running',
    cuaVersion: 'v3',
    maxSteps: 25,
    budgetCents: 500,
    costCents: 0,
    stepsCompleted: 0,
    result: null as { passed?: boolean; summary?: string } | null,
    error: null as { code?: string; message?: string } | null,
    awaitingHumanReason: null as string | null,
    createdAt: '',
    finishedAt: null as string | null,
    ...overrides,
  };
}

export function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf1',
    name: 'Invoice flow',
    slug: 'invoice-flow',
    version: 1,
    description: null as string | null,
    status: 'active',
    definition: {
      steps: [
        { id: 'fetch', type: 'task', task: 'Open order and read the invoice total' },
        {
          id: 'branch',
          type: 'if',
          then: [{ id: 'ok', type: 'succeed' }],
          else: [{ id: 'fail', type: 'fail' }],
        },
        { id: 'gate', type: 'human_approval', message: 'Approve?' },
      ],
    } as Record<string, unknown>,
    ...overrides,
  };
}

export function makeWorkflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wfr1',
    workflowId: 'wf1',
    status: 'running',
    budgetCents: 200,
    spentCents: 0,
    awaitingStepId: null as string | null,
    awaitingReason: null as string | null,
    output: null as Record<string, unknown> | null,
    error: null as { code?: string; message?: string } | null,
    createdAt: '',
    finishedAt: null as string | null,
    ...overrides,
  };
}

export type { RunDtoLike };

/** One SSE frame to serialize into a stream. */
export interface SseFrame {
  id?: number | string;
  event?: string;
  data?: unknown;
}

/** Serialize SSE frames into a wire-format string (blank-line terminated). */
export function encodeSseFrames(frames: SseFrame[]): string {
  return frames
    .map((f) => {
      const lines: string[] = [];
      if (f.id !== undefined) lines.push(`id: ${String(f.id)}`);
      if (f.event !== undefined) lines.push(`event: ${f.event}`);
      const data = typeof f.data === 'string' ? f.data : JSON.stringify(f.data ?? {});
      lines.push(`data: ${data}`);
      return lines.join('\n') + '\n\n';
    })
    .join('');
}

/** A ReadableStream<Uint8Array> that emits the given SSE text (optionally in chunks). */
export function sseStream(text: string, chunkSize = 0): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = chunkSize > 0 ? chunkSize : bytes.length;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** Build a Response-like object backed by an SSE body stream. */
export function sseResponse(frames: SseFrame[]): Response {
  return {
    ok: true,
    status: 200,
    body: sseStream(encodeSseFrames(frames)),
  } as unknown as Response;
}
