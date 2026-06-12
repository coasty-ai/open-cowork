import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowRunsScreen } from '../src/screens/WorkflowRunsScreen';
import { setToken, type WorkflowRunDto } from '../src/api';
import { bodyOf, findCall, jsonRes, makeWorkflowRun, stubFetch, type FetchMock } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

function stubWorkflowFetch(state: { run: WorkflowRunDto }): FetchMock {
  return stubFetch((url, init) => {
    if (url.endsWith('/resume') && init?.method === 'POST') {
      const body = bodyOf(init) as { approved: boolean };
      state.run = {
        ...state.run,
        status: body.approved ? 'running' : 'cancelled',
        awaitingStepId: null,
        awaitingReason: null,
      };
      return jsonRes(state.run);
    }
    if (url.includes(`/api/workflows/runs/${state.run.id}`)) return jsonRes(state.run);
    if (url.endsWith('/api/workflows/runs')) return jsonRes({ runs: [state.run] });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('WorkflowRunsScreen', () => {
  it('lists workflow runs and opens the detail-lite view', async () => {
    const state = { run: makeWorkflowRun() };
    stubWorkflowFetch(state);
    render(<WorkflowRunsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open workflow run wfr_1' }));

    expect(await screen.findByText('Approve sending the weekly report')).toBeInTheDocument();
    expect(screen.getByText(/Waiting on step/)).toBeInTheDocument();
    expect(screen.getByText(/Spent \$1\.20 of \$10\.00 budget/)).toBeInTheDocument();
  });

  it('approves a paused workflow run with {approved: true, note}', async () => {
    const state = { run: makeWorkflowRun() };
    const fetchMock = stubWorkflowFetch(state);
    render(<WorkflowRunsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open workflow run wfr_1' }));
    fireEvent.change(await screen.findByLabelText('Approval note'), {
      target: { value: 'send it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(findCall(fetchMock, '/api/workflows/runs/wfr_1/resume')).toBeDefined());
    const call = findCall(fetchMock, '/api/workflows/runs/wfr_1/resume');
    expect(bodyOf(call!.init)).toEqual({ approved: true, note: 'send it' });
    expect(await screen.findByText('running')).toBeInTheDocument();
  });

  it('rejects a paused workflow run with {approved: false}', async () => {
    const state = { run: makeWorkflowRun() };
    const fetchMock = stubWorkflowFetch(state);
    render(<WorkflowRunsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open workflow run wfr_1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(findCall(fetchMock, '/api/workflows/runs/wfr_1/resume')).toBeDefined());
    const call = findCall(fetchMock, '/api/workflows/runs/wfr_1/resume');
    expect(bodyOf(call!.init)).toEqual({ approved: false });
    expect(await screen.findByText('cancelled')).toBeInTheDocument();
  });

  it('shows the empty state when there are no workflow runs', async () => {
    stubFetch(() => jsonRes({ runs: [] }));
    render(<WorkflowRunsScreen />);
    expect(await screen.findByText('No workflow runs yet.')).toBeInTheDocument();
  });
});
