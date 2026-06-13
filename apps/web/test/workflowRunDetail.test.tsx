/**
 * WorkflowRunDetailPage: SSE timeline + budget gauge, the awaiting_human
 * ApprovalBar (Approve/Reject call resumeWorkflowRun), cancel, and the
 * terminal result/output panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { WorkflowRunDetailPage } from '../src/pages/WorkflowRunDetailPage';
import { stubClient, makeWorkflowRun, encodeSseFrames, sseStream, type SseFrame } from './helpers';

function stubSse(frames: SseFrame[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: sseStream(encodeSseFrames(frames)),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderRun() {
  return render(
    <MemoryRouter initialEntries={['/workflows/runs/wfr1']}>
      <Routes>
        <Route path="/workflows/runs/:id" element={<WorkflowRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuth.setState({ token: 'cwk_t', user: { id: 'u1', email: 'a@b.c', budgetCents: 500 } });
});

afterEach(() => {
  cleanup();
  setClientForTests(null);
  useAuth.setState({ token: null, user: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkflowRunDetailPage', () => {
  it('renders the timeline and the budget gauge', async () => {
    stubSse([
      { id: 1, event: 'status', data: { status: 'running' } },
      { id: 2, event: 'billing', data: { spent_cents: 60 } },
    ]);
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () =>
          makeWorkflowRun({ status: 'running', spentCents: 60, budgetCents: 200 }),
        ),
      }),
    );
    renderRun();
    const log = await screen.findByRole('log');
    await waitFor(() => expect(within(log).getByText('Status → running')).toBeInTheDocument());
    expect(screen.getByText(/spent \$0\.60 \/ cap \$2\.00/)).toBeInTheDocument();
  });

  it('awaiting_human: Approve calls resumeWorkflowRun(approved=true)', async () => {
    stubSse([{ id: 1, event: 'awaiting_human', data: { reason: 'approve publish' } }]);
    const resumeWorkflowRun = vi.fn(async () => makeWorkflowRun({ status: 'running' }));
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () =>
          makeWorkflowRun({ status: 'awaiting_human', awaitingReason: 'Publish the result?' }),
        ),
        resumeWorkflowRun,
      }),
    );
    renderRun();
    expect(await screen.findByText('Publish the result?')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/note/i), 'go ahead');
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith('wfr1', true, 'go ahead'));
  });

  it('awaiting_human: Reject calls resumeWorkflowRun(approved=false)', async () => {
    stubSse([{ id: 1, event: 'awaiting_human', data: {} }]);
    const resumeWorkflowRun = vi.fn(async () => makeWorkflowRun({ status: 'cancelled' }));
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () =>
          makeWorkflowRun({ status: 'awaiting_human', awaitingStepId: 'gate' }),
        ),
        resumeWorkflowRun,
      }),
    );
    renderRun();
    // Falls back to the step-id reason when awaitingReason is null.
    expect(await screen.findByText(/Step 'gate' needs your approval/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith('wfr1', false, undefined));
  });

  it('Cancel calls cancelWorkflowRun', async () => {
    stubSse([{ id: 1, event: 'status', data: { status: 'running' } }]);
    const cancelWorkflowRun = vi.fn(async () => makeWorkflowRun({ status: 'cancelled' }));
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () => makeWorkflowRun({ status: 'running' })),
        cancelWorkflowRun,
      }),
    );
    renderRun();
    await userEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith('wfr1'));
  });

  it('shows the JSON output in the result panel on success', async () => {
    stubSse([{ id: 1, event: 'done', data: { status: 'succeeded' } }]);
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () =>
          makeWorkflowRun({ status: 'succeeded', output: { total: 4200 } }),
        ),
      }),
    );
    renderRun();
    expect(await screen.findByRole('heading', { name: /result/i })).toBeInTheDocument();
    expect(screen.getByText(/"total": 4200/)).toBeInTheDocument();
  });

  it('shows the error in the result panel on failure', async () => {
    stubSse([{ id: 1, event: 'done', data: { status: 'failed' } }]);
    setClientForTests(
      stubClient({
        getWorkflowRun: vi.fn(async () =>
          makeWorkflowRun({
            status: 'failed',
            error: { code: 'ASSERT_FAILED', message: 'check failed' },
          }),
        ),
      }),
    );
    renderRun();
    expect(await screen.findByText(/ASSERT_FAILED: check failed/)).toBeInTheDocument();
  });

  it('shows a plain finished line when there is no output or error', async () => {
    stubSse([{ id: 1, event: 'done', data: { status: 'cancelled' } }]);
    setClientForTests(
      stubClient({ getWorkflowRun: vi.fn(async () => makeWorkflowRun({ status: 'cancelled' })) }),
    );
    renderRun();
    expect(await screen.findByText('Finished cancelled.')).toBeInTheDocument();
  });

  it('shows an error state with retry when the run fails to load', async () => {
    stubSse([]);
    const getWorkflowRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('run gone'))
      .mockResolvedValue(makeWorkflowRun({ status: 'running' }));
    setClientForTests(stubClient({ getWorkflowRun }));
    renderRun();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('run gone');
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
