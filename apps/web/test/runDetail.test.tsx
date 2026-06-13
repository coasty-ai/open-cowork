/**
 * RunDetailPage: SSE-driven timeline + cost summary on terminal status,
 * the awaiting_human ApprovalBar (Approve calls resumeRun), and the cancel path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { RunDetailPage } from '../src/pages/RunDetailPage';
import { stubClient, makeRun, encodeSseFrames, sseStream, type SseFrame } from './helpers';

/** Stub global fetch so any /events stream yields the given frames once. */
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
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes>
        <Route path="/runs/:id" element={<RunDetailPage />} />
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

describe('RunDetailPage', () => {
  it('renders mapped SSE events in the timeline', async () => {
    stubSse([
      { id: 1, event: 'status', data: { status: 'running' } },
      { id: 2, event: 'step', data: { steps_completed: 2 } },
      { id: 3, event: 'billing', data: { cost_cents: 40 } },
      { id: 4, event: 'done', data: { status: 'succeeded' } },
    ]);
    // First getRun resolves running; after the 'done' event refresh sees terminal.
    const getRun = vi
      .fn()
      .mockResolvedValueOnce(makeRun({ status: 'running' }))
      .mockResolvedValue(
        makeRun({
          status: 'succeeded',
          costCents: 40,
          stepsCompleted: 2,
          result: { summary: 'All invoices downloaded' },
          finishedAt: '2026-06-12T00:01:00Z',
        }),
      );
    setClientForTests(stubClient({ getRun }));
    renderRun();

    const log = await screen.findByRole('log');
    await waitFor(() => expect(within(log).getByText('Status → running')).toBeInTheDocument());
    expect(within(log).getByText('Step 2 completed')).toBeInTheDocument();
    expect(within(log).getByText('Spend so far: $0.40')).toBeInTheDocument();
    expect(within(log).getByText('Finished: succeeded')).toBeInTheDocument();
  });

  it('shows the cost summary once the run is terminal', async () => {
    stubSse([{ id: 1, event: 'done', data: { status: 'succeeded' } }]);
    const getRun = vi.fn(async () =>
      makeRun({
        status: 'succeeded',
        costCents: 137,
        stepsCompleted: 5,
        result: { summary: 'Wrapped up cleanly' },
      }),
    );
    setClientForTests(stubClient({ getRun }));
    renderRun();

    expect(await screen.findByRole('heading', { name: /summary/i })).toBeInTheDocument();
    expect(screen.getByText(/after 5 steps/i)).toBeInTheDocument();
    expect(screen.getByText('Wrapped up cleanly')).toBeInTheDocument();
    // Two actual-cost pills ($1.37) — header + summary.
    const pills = screen.getAllByLabelText('actual cost $1.37');
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the error code+message in the summary for a failed run', async () => {
    stubSse([{ id: 1, event: 'done', data: { status: 'failed' } }]);
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () =>
          makeRun({ status: 'failed', error: { code: 'GUARD_EXCEEDED', message: 'over budget' } }),
        ),
      }),
    );
    renderRun();
    expect(await screen.findByText(/GUARD_EXCEEDED: over budget/)).toBeInTheDocument();
  });

  it('awaiting_human shows the ApprovalBar; Approve calls resumeRun with the note', async () => {
    stubSse([{ id: 1, event: 'awaiting_human', data: { reason: 'captcha' } }]);
    const resumeRun = vi.fn(async () => makeRun({ status: 'running' }));
    const getRun = vi.fn(async () =>
      makeRun({ status: 'awaiting_human', awaitingHumanReason: 'Solve the captcha please' }),
    );
    setClientForTests(stubClient({ getRun, resumeRun }));
    renderRun();

    expect(await screen.findByText('Solve the captcha please')).toBeInTheDocument();
    const note = screen.getByLabelText(/note/i);
    await userEvent.type(note, 'looks good');
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('r1', 'looks good'));
  });

  it('Approve with no note resumes with undefined', async () => {
    stubSse([{ id: 1, event: 'awaiting_human', data: {} }]);
    const resumeRun = vi.fn(async () => makeRun({ status: 'running' }));
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () => makeRun({ status: 'awaiting_human' })),
        resumeRun,
      }),
    );
    renderRun();
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('r1', undefined));
  });

  it('Cancel run calls cancelRun', async () => {
    stubSse([{ id: 1, event: 'status', data: { status: 'running' } }]);
    const cancelRun = vi.fn(async () => makeRun({ status: 'cancelled' }));
    setClientForTests(
      stubClient({ getRun: vi.fn(async () => makeRun({ status: 'running' })), cancelRun }),
    );
    renderRun();
    await userEvent.click(await screen.findByRole('button', { name: /cancel run/i }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('r1'));
  });

  it('shows an error state with retry when getRun fails', async () => {
    stubSse([]);
    const getRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('run not found'))
      .mockResolvedValue(makeRun({ status: 'running' }));
    setClientForTests(stubClient({ getRun }));
    renderRun();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('run not found');
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
