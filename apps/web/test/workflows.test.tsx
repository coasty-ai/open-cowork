/**
 * WorkflowsPage: list + runs, empty state, the builder (Validate surfaces
 * issues when invalid / estimate when valid; Save creates + navigates).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { CoastyKeyProvider } from '../src/coastyKey';
import { WorkflowsPage } from '../src/pages/WorkflowsPage';
import { stubClient, makeWorkflow, makeWorkflowRun } from './helpers';

function renderWorkflows() {
  return render(
    <MemoryRouter initialEntries={['/workflows']}>
      <CoastyKeyProvider>
        <Routes>
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:id" element={<div>workflow detail</div>} />
        </Routes>
      </CoastyKeyProvider>
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

describe('WorkflowsPage', () => {
  it('shows the API-key gate (no new-workflow action) when no key is configured', async () => {
    setClientForTests(
      stubClient({
        coastyKeyStatus: vi.fn(async () => ({
          configured: false,
          mode: null,
          demoMode: true,
          source: 'demo',
        })),
      }),
    );
    renderWorkflows();
    expect(await screen.findByText(/workflows need a coasty api key/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new workflow/i })).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no workflows or runs', async () => {
    setClientForTests(
      stubClient({
        listWorkflows: vi.fn(async () => ({ workflows: [] })),
        listWorkflowRuns: vi.fn(async () => ({ runs: [] })),
      }),
    );
    renderWorkflows();
    expect(await screen.findByText(/no workflows yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no workflow runs yet/i)).toBeInTheDocument();
  });

  it('lists workflows and recent workflow runs', async () => {
    setClientForTests(
      stubClient({
        listWorkflows: vi.fn(async () => ({
          workflows: [
            makeWorkflow({ id: 'wf1', name: 'Invoice flow', slug: 'invoice', version: 3 }),
          ],
        })),
        listWorkflowRuns: vi.fn(async () => ({
          runs: [
            makeWorkflowRun({
              id: 'wfr_42',
              status: 'succeeded',
              spentCents: 80,
              budgetCents: 200,
            }),
          ],
        })),
      }),
    );
    renderWorkflows();
    expect(await screen.findByText('Invoice flow')).toBeInTheDocument();
    expect(screen.getByText('(invoice)')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('wfr_42')).toBeInTheDocument();
    expect(screen.getByText(/spent \$0\.80 \/ cap \$2\.00/)).toBeInTheDocument();
  });

  it('shows an error state with retry on load failure', async () => {
    const listWorkflows = vi
      .fn()
      .mockRejectedValueOnce(new Error('backend offline'))
      .mockResolvedValue({ workflows: [] });
    setClientForTests(stubClient({ listWorkflows }));
    renderWorkflows();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('backend offline');
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/no workflows yet/i)).toBeInTheDocument();
  });

  it('Validate surfaces backend issues when the definition is invalid', async () => {
    const validateWorkflow = vi.fn(async () => ({
      valid: false,
      issues: [{ path: 'steps[0]', code: 'BAD', message: 'unknown step type' }],
      estimate: null,
    }));
    setClientForTests(stubClient({ validateWorkflow }));
    renderWorkflows();
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    await userEvent.click(await screen.findByRole('button', { name: /validate \+ estimate/i }));
    await waitFor(() => expect(validateWorkflow).toHaveBeenCalled());
    const issues = screen.getByRole('list', { name: /validation issues/i });
    expect(within(issues).getByText('unknown step type')).toBeInTheDocument();
    expect(within(issues).getByText('steps[0]')).toBeInTheDocument();
  });

  it('Validate shows the estimate when the definition is valid', async () => {
    setClientForTests(
      stubClient({
        validateWorkflow: vi.fn(async () => ({
          valid: true,
          issues: [],
          estimate: { typicalCents: 80, worstCaseCents: 250 },
        })),
      }),
    );
    renderWorkflows();
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    await userEvent.click(await screen.findByRole('button', { name: /validate \+ estimate/i }));
    expect(await screen.findByText(/typical \$0\.80, worst case \$2\.50/)).toBeInTheDocument();
  });

  it('reports invalid JSON locally without calling the backend', async () => {
    const validateWorkflow = vi.fn(async () => ({ valid: true, issues: [], estimate: null }));
    setClientForTests(stubClient({ validateWorkflow }));
    renderWorkflows();
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    const editor = screen.getByLabelText(/definition/i);
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{not json');
    await userEvent.click(screen.getByRole('button', { name: /validate \+ estimate/i }));
    expect(await screen.findByText(/not valid json/i)).toBeInTheDocument();
    expect(validateWorkflow).not.toHaveBeenCalled();
  });

  it('Save validates, creates the workflow, and navigates to it', async () => {
    const createWorkflow = vi.fn(async () => makeWorkflow({ id: 'wf_created' }));
    setClientForTests(
      stubClient({
        validateWorkflow: vi.fn(async () => ({
          valid: true,
          issues: [],
          estimate: { typicalCents: 10, worstCaseCents: 20 },
        })),
        createWorkflow,
      }),
    );
    renderWorkflows();
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    await userEvent.type(screen.getByLabelText(/^name/i), 'My flow');
    await userEvent.type(screen.getByLabelText(/^slug/i), 'my-flow');
    await userEvent.click(screen.getByRole('button', { name: /save workflow/i }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    const [arg] = createWorkflow.mock.calls[0]! as unknown as [{ name: string; slug: string }];
    expect(arg.name).toBe('My flow');
    expect(arg.slug).toBe('my-flow');
    expect(await screen.findByText('workflow detail')).toBeInTheDocument();
  });

  it('does not save when validation reports the definition invalid', async () => {
    const createWorkflow = vi.fn(async () => makeWorkflow());
    setClientForTests(
      stubClient({
        validateWorkflow: vi.fn(async () => ({
          valid: false,
          issues: [{ path: '', code: 'X', message: 'broken' }],
          estimate: null,
        })),
        createWorkflow,
      }),
    );
    renderWorkflows();
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    await userEvent.type(screen.getByLabelText(/^name/i), 'My flow');
    await userEvent.type(screen.getByLabelText(/^slug/i), 'my-flow');
    await userEvent.click(screen.getByRole('button', { name: /save workflow/i }));
    expect(await screen.findByText('broken')).toBeInTheDocument();
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});
