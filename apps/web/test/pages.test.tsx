/**
 * Page tests with a stubbed BackendClient: login flow, the delegate→confirm
 * cost→start flow, empty/error states, and budget-error surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, type BackendClient } from '../src/api/client';
import { setClientForTests, useAuth } from '../src/store';
import { CoastyKeyProvider } from '../src/coastyKey';
import { LoginPage } from '../src/pages/LoginPage';
import { HomePage } from '../src/pages/HomePage';
import { MachinesPage } from '../src/pages/MachinesPage';

type Stub = Partial<Record<keyof BackendClient, unknown>>;

function stubClient(overrides: Stub = {}): BackendClient {
  const base = {
    url: (p: string) => p,
    authHeaders: () => ({}),
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
    coastyKeyStatus: vi.fn(async () => ({
      configured: true,
      mode: 'test',
      demoMode: false,
      source: 'env',
    })),
    setCoastyKey: vi.fn(async () => ({
      ok: true,
      configured: true,
      mode: 'test',
      demoMode: false,
      source: 'runtime',
    })),
    clearCoastyKey: vi.fn(async () => ({
      configured: false,
      mode: null,
      demoMode: true,
      source: 'demo',
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
    createRun: vi.fn(async () => ({
      id: 'r_new',
      kind: 'coasty',
      machineId: 'm1',
      task: 't',
      status: 'queued',
      cuaVersion: 'v3',
      maxSteps: 25,
      budgetCents: 500,
      costCents: 0,
      stepsCompleted: 0,
      result: null,
      error: null,
      awaitingHumanReason: null,
      createdAt: '',
      finishedAt: null,
    })),
    createMachine: vi.fn(async () => ({ machine: { id: 'm2' } })),
    startMachine: vi.fn(async () => ({})),
    stopMachine: vi.fn(async () => ({})),
    terminateMachine: vi.fn(async () => ({})),
    ...overrides,
  };
  return base as unknown as BackendClient;
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

describe('LoginPage', () => {
  it('logs in and stores the session', async () => {
    useAuth.setState({ token: null, user: null });
    const client = stubClient();
    setClientForTests(client);
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>home!</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText(/email/i), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(useAuth.getState().token).toBe('cwk_test_token'));
    expect(screen.getByText('home!')).toBeInTheDocument();
  });

  it('shows the error when login fails', async () => {
    useAuth.setState({ token: null, user: null });
    setClientForTests(
      stubClient({
        login: vi.fn(async () => Promise.reject(new ApiError(500, 'X', 'backend down'))),
      }),
    );
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText(/email/i), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/backend down/)).toBeInTheDocument();
  });
});

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:id" element={<div>run page</div>} />
        <Route path="/machines" element={<div>machines page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomePage (delegate flow)', () => {
  it('requires an explicit cost confirmation before starting a run', async () => {
    const client = stubClient();
    setClientForTests(client);
    renderHome();

    // Loads machines + estimate, shows the composer.
    const taskBox = await screen.findByLabelText(/task/i);
    await userEvent.type(taskBox, 'Download the invoices');
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: /worker-1/ }));
    await userEvent.click(screen.getByRole('button', { name: /delegate|run|start|submit|send/i }));

    // Confirm modal: nothing started yet.
    expect(client.createRun).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: /confirm cost/i });
    expect(dialog).toHaveTextContent('$1.25'); // 125¢ estimate surfaced

    await userEvent.click(screen.getByRole('button', { name: /start run/i }));
    await waitFor(() => expect(client.createRun).toHaveBeenCalledTimes(1));
    const call = (client.createRun as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      confirmCostCents: number;
      machineId: string;
    };
    expect(call.confirmCostCents).toBe(125); // echoes the server estimate
    expect(call.machineId).toBe('m1');
    expect(await screen.findByText('run page')).toBeInTheDocument();
  });

  it('surfaces backend budget errors in the confirm dialog', async () => {
    const client = stubClient({
      createRun: vi.fn(async () =>
        Promise.reject(
          new ApiError(422, 'BUDGET_EXCEEDED', 'Worst-case cost 500¢ exceeds the budget cap 100¢'),
        ),
      ),
    });
    setClientForTests(client);
    renderHome();
    await userEvent.type(await screen.findByLabelText(/task/i), 'big job');
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: /worker-1/ }));
    await userEvent.click(screen.getByRole('button', { name: /delegate|run|start|submit|send/i }));
    await userEvent.click(await screen.findByRole('button', { name: /start run/i }));
    expect(await screen.findByText(/exceeds the budget cap/)).toBeInTheDocument();
  });

  it('shows an empty state when no machine is running', async () => {
    setClientForTests(stubClient({ listMachines: vi.fn(async () => ({ machines: [] })) }));
    renderHome();
    expect(await screen.findByText(/no machine to run on/i)).toBeInTheDocument();
  });

  it('shows the error state when loading fails', async () => {
    setClientForTests(
      stubClient({
        listMachines: vi.fn(async () =>
          Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline')),
        ),
      }),
    );
    renderHome();
    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/);
  });
});

describe('MachinesPage', () => {
  it('shows the API-key gate (no provision action) when no key is configured', async () => {
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
    render(
      <MemoryRouter>
        <CoastyKeyProvider>
          <MachinesPage />
        </CoastyKeyProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/machines need a coasty api key/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /provision machine/i })).not.toBeInTheDocument();
  });

  it('provisions a machine with the rate confirmation', async () => {
    const client = stubClient();
    setClientForTests(client);
    render(
      <MemoryRouter>
        <CoastyKeyProvider>
          <MachinesPage />
        </CoastyKeyProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /provision machine/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/\$0\.05\/hour/);
    await userEvent.click(screen.getByRole('button', { name: /confirm — provision/i }));
    await waitFor(() => expect(client.createMachine).toHaveBeenCalled());
    const call = (client.createMachine as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      confirmCostCents: number;
    };
    expect(call.confirmCostCents).toBe(5); // linux rate handshake
  });

  it('renders the wallet card with balance', async () => {
    setClientForTests(stubClient());
    render(
      <MemoryRouter>
        <CoastyKeyProvider>
          <MachinesPage />
        </CoastyKeyProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/\$93\.00/)).toBeInTheDocument();
  });
});
