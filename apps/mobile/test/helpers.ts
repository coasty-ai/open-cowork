/**
 * Shared test helpers: per-test global fetch stubbing with a tiny URL router,
 * plus fixture factories for the backend DTOs.
 */
import { vi, type Mock } from 'vitest';
import type { MachineDto, RunDto, WalletDto, WorkflowRunDto } from '../src/api';

/** Minimal Response stand-in — api.ts only touches ok/status/json(). */
export function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

export type FetchMock = Mock<(input: unknown, init?: RequestInit) => Promise<Response>>;

/** Install a fetch stub for this test; remember to vi.unstubAllGlobals() after. */
export function stubFetch(handler: FetchHandler): FetchMock {
  const mock: FetchMock = vi.fn(async (input: unknown, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Parse the JSON body a stubbed fetch call was made with. */
export function bodyOf(init: RequestInit | undefined): unknown {
  return init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
}

/** All URLs the mock saw, in order. */
export function calledUrls(mock: FetchMock): string[] {
  return mock.mock.calls.map((c) => String(c[0]));
}

/** Find the first call whose URL contains the fragment. */
export function findCall(
  mock: FetchMock,
  fragment: string,
): { url: string; init: RequestInit | undefined } | undefined {
  const call = mock.mock.calls.find((c) => String(c[0]).includes(fragment));
  return call ? { url: String(call[0]), init: call[1] } : undefined;
}

// ── fixtures ────────────────────────────────────────────────────────────────

export function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: 'r_1',
    kind: 'coasty',
    machineId: 'mch_test_1',
    task: 'Open the dashboard and export the report',
    status: 'running',
    cuaVersion: 'v3',
    maxSteps: 25,
    budgetCents: 500,
    costCents: 15,
    stepsCompleted: 3,
    result: null,
    error: null,
    awaitingHumanReason: null,
    createdAt: '2026-06-11T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

export function makeWorkflowRun(overrides: Partial<WorkflowRunDto> = {}): WorkflowRunDto {
  return {
    id: 'wfr_1',
    workflowId: 'wf_1',
    status: 'awaiting_human',
    budgetCents: 1000,
    spentCents: 120,
    awaitingStepId: 'approve_send',
    awaitingReason: 'Approve sending the weekly report',
    output: null,
    error: null,
    createdAt: '2026-06-11T09:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

export function makeMachine(overrides: Partial<MachineDto> = {}): MachineDto {
  return {
    id: 'mch_test_1',
    display_name: 'worker-1',
    status: 'running',
    os_type: 'linux',
    is_test: true,
    created_at: '2026-06-10T08:00:00.000Z',
    ...overrides,
  };
}

export function makeWallet(overrides: Partial<WalletDto> = {}): WalletDto {
  return {
    balanceCents: 1234,
    periodCostCents: 250,
    period: '2026-06',
    monthSpendCents: 250,
    ...overrides,
  };
}
