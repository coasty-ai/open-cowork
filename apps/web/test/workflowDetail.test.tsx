/**
 * WorkflowDetailPage: definition + step tree from parsed steps; Run dialog
 * (machine + budget cap -> startWorkflowRun with confirmCostCents === budgetCents);
 * validate+save bumps via updateWorkflow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { WorkflowDetailPage } from '../src/pages/WorkflowDetailPage';
import { stubClient, makeWorkflow, makeWorkflowRun } from './helpers';

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/workflows/wf1']}>
      <Routes>
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/workflows/runs/:id" element={<div>workflow run page</div>} />
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
});

describe('WorkflowDetailPage', () => {
  it('renders the definition and a step tree from the parsed steps', async () => {
    setClientForTests(stubClient());
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Invoice flow' })).toBeInTheDocument();

    // The step tree renders each top-level step id + type.
    const tree = screen.getByRole('tree');
    expect(within(tree).getByText('branch')).toBeInTheDocument(); // type label
    expect(within(tree).getByText('human_approval')).toBeInTheDocument();
    // The 'if' step has then/else children -> it's expandable.
    expect(screen.getByTestId('step-dot-fetch')).toBeInTheDocument();
    expect(screen.getByTestId('step-dot-branch')).toBeInTheDocument();
    // Nested children appear under the branch.
    expect(screen.getByTestId('step-dot-ok')).toBeInTheDocument();
    expect(screen.getByTestId('step-dot-fail')).toBeInTheDocument();
  });

  it('Run dialog: selecting a machine + confirming starts with confirmCostCents === budgetCents', async () => {
    const startWorkflowRun = vi.fn(async () => makeWorkflowRun({ id: 'wfr_started' }));
    setClientForTests(
      stubClient({
        listMachines: vi.fn(async () => ({
          machines: [
            {
              id: 'mX',
              display_name: 'runner-X',
              status: 'running',
              os_type: 'linux',
              is_test: true,
              created_at: '',
            },
          ],
        })),
        startWorkflowRun,
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /run workflow/i }));
    const dialog = await screen.findByRole('dialog');

    // Budget cap defaults to 200 cents -> confirm button shows $2.00 and is disabled until a machine.
    const confirm = within(dialog).getByRole('button', { name: /confirm \$2\.00 cap — start/i });
    expect(confirm).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText(/machine/i), 'mX');
    expect(confirm).toBeEnabled();

    // Change the cap to 350 cents.
    const capInput = within(dialog).getByLabelText(/budget cap/i);
    await userEvent.clear(capInput);
    await userEvent.type(capInput, '350');

    await userEvent.click(within(dialog).getByRole('button', { name: /confirm .* start/i }));
    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledTimes(1));
    const [wfId, body] = startWorkflowRun.mock.calls[0]! as unknown as [
      string,
      { budgetCents: number; confirmCostCents: number; machineId?: string },
    ];
    expect(wfId).toBe('wf1');
    expect(body.machineId).toBe('mX');
    expect(body.budgetCents).toBe(350);
    expect(body.confirmCostCents).toBe(350); // handshake: confirm echoes the cap
    expect(await screen.findByText('workflow run page')).toBeInTheDocument();
  });

  it('passes parsed inputs JSON through to startWorkflowRun', async () => {
    const startWorkflowRun = vi.fn(async () => makeWorkflowRun({ id: 'wfr_inputs' }));
    setClientForTests(
      stubClient({
        listMachines: vi.fn(async () => ({
          machines: [
            {
              id: 'mX',
              display_name: 'runner-X',
              status: 'running',
              os_type: 'linux',
              is_test: true,
              created_at: '',
            },
          ],
        })),
        startWorkflowRun,
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /run workflow/i }));
    const dialog = await screen.findByRole('dialog');
    const inputs = within(dialog).getByLabelText(/inputs/i);
    await userEvent.clear(inputs);
    await userEvent.type(inputs, '{{"order_id":"o-9"}');
    await userEvent.selectOptions(within(dialog).getByLabelText(/machine/i), 'mX');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm .* start/i }));
    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());
    const [, body] = startWorkflowRun.mock.calls[0]! as unknown as [
      string,
      { inputs?: Record<string, unknown> },
    ];
    expect(body.inputs).toEqual({ order_id: 'o-9' });
  });

  it('surfaces a backend error when starting the run fails', async () => {
    setClientForTests(
      stubClient({
        listMachines: vi.fn(async () => ({
          machines: [
            {
              id: 'mX',
              display_name: 'runner-X',
              status: 'running',
              os_type: 'linux',
              is_test: true,
              created_at: '',
            },
          ],
        })),
        startWorkflowRun: vi.fn(async () => Promise.reject(new Error('budget too low'))),
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /run workflow/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(/machine/i), 'mX');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm .* start/i }));
    expect(await screen.findByText('budget too low')).toBeInTheDocument();
  });

  it('validate + save bumps the version via updateWorkflow when valid', async () => {
    const updateWorkflow = vi.fn(async () => makeWorkflow({ version: 2 }));
    const validateWorkflow = vi.fn(async () => ({ valid: true, issues: [], estimate: null }));
    setClientForTests(stubClient({ updateWorkflow, validateWorkflow }));
    renderDetail();
    await screen.findByRole('heading', { name: 'Invoice flow' });
    // v1 badge before save.
    expect(screen.getByText('v1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /validate \+ save/i }));
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [updatedId] = updateWorkflow.mock.calls[0]! as unknown as [string, unknown];
    expect(updatedId).toBe('wf1');
    expect(await screen.findByText('v2')).toBeInTheDocument();
  });

  it('validate + save shows issues and does NOT update when invalid', async () => {
    const updateWorkflow = vi.fn(async () => makeWorkflow({ version: 2 }));
    setClientForTests(
      stubClient({
        validateWorkflow: vi.fn(async () => ({
          valid: false,
          issues: [{ path: 'steps[1]', code: 'X', message: 'missing condition' }],
          estimate: null,
        })),
        updateWorkflow,
      }),
    );
    renderDetail();
    await screen.findByRole('heading', { name: 'Invoice flow' });
    await userEvent.click(screen.getByRole('button', { name: /validate \+ save/i }));
    expect(await screen.findByText('missing condition')).toBeInTheDocument();
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it('shows an error state when the workflow fails to load', async () => {
    setClientForTests(
      stubClient({ getWorkflow: vi.fn(async () => Promise.reject(new Error('no such workflow'))) }),
    );
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('no such workflow');
  });
});
