/**
 * RunsPage (list with local/cloud markers, empty state, error+retry) and
 * SettingsPage (loads me, saves the budget via the /api/me/budget PATCH fetch,
 * theme toggle flips data-theme).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { RunsPage } from '../src/pages/RunsPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { stubClient, makeRun } from './helpers';

beforeEach(() => {
  useAuth.setState({ token: 'cwk_t', user: { id: 'u1', email: 'a@b.c', budgetCents: 500 } });
});

afterEach(() => {
  cleanup();
  setClientForTests(null);
  useAuth.setState({ token: null, user: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

function renderRuns() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<RunsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RunsPage', () => {
  it('renders runs with local/cloud markers', async () => {
    setClientForTests(
      stubClient({
        listRuns: vi.fn(async () => ({
          runs: [
            makeRun({
              id: 'r_cloud',
              kind: 'coasty',
              task: 'Cloud task',
              stepsCompleted: 4,
              costCents: 120,
            }),
            makeRun({
              id: 'r_local',
              kind: 'local',
              task: 'Local task',
              stepsCompleted: 2,
              costCents: 0,
            }),
          ],
        })),
      }),
    );
    renderRuns();
    const cloud = await screen.findByText(/Cloud task/);
    const local = screen.getByText(/Local task/);
    // Cloud marker ☁, local marker 💻 live in the same element as the task text.
    expect(cloud.textContent).toContain('☁');
    expect(local.textContent).toContain('💻');
    expect(screen.getByText('4 steps')).toBeInTheDocument();
    expect(screen.getByLabelText('actual cost $1.20')).toBeInTheDocument();
  });

  it('renders the empty state when there are no runs', async () => {
    setClientForTests(stubClient({ listRuns: vi.fn(async () => ({ runs: [] })) }));
    renderRuns();
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });

  it('shows an error state and recovers via retry', async () => {
    const listRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue({ runs: [] });
    setClientForTests(stubClient({ listRuns }));
    renderRuns();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('list failed');
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });

  it('clears the polling interval on unmount (no late re-render)', async () => {
    vi.useFakeTimers();
    const listRuns = vi.fn(async () => ({ runs: [] }));
    setClientForTests(stubClient({ listRuns }));
    const { unmount } = renderRuns();
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    unmount();
    await vi.advanceTimersByTimeAsync(15000);
    // No further polls after unmount.
    expect(listRuns).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('SettingsPage', () => {
  it('loads the current budget + month spend', async () => {
    setClientForTests(
      stubClient({
        me: vi.fn(async () => ({
          user: { id: 'u1', email: 'a@b.c', budgetCents: 750 },
          monthSpendCents: 321,
        })),
      }),
    );
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const input = (await screen.findByLabelText(/budget cap/i)) as HTMLInputElement;
    expect(input.value).toBe('750');
    expect(screen.getByText(/This month: \$3\.21/)).toBeInTheDocument();
  });

  it('saves the budget via a PATCH to /api/me/budget and shows Saved', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setClientForTests(
      stubClient({
        me: vi.fn(async () => ({
          user: { id: 'u1', email: 'a@b.c', budgetCents: 500 },
          monthSpendCents: 0,
        })),
      }),
    );
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText(/budget cap/i);
    await userEvent.clear(input);
    await userEvent.type(input, '900');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('/api/me/budget');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer cwk_t');
    expect(JSON.parse(init.body)).toEqual({ budgetCents: 900 });
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
    // Budget persisted into the auth store.
    expect(useAuth.getState().user?.budgetCents).toBe(900);
  });

  it('surfaces a save failure as an error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    setClientForTests(stubClient());
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saving the budget failed/i);
  });

  it('shows an error state when loading settings fails', async () => {
    setClientForTests(
      stubClient({ me: vi.fn(async () => Promise.reject(new Error('me failed'))) }),
    );
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('me failed');
  });

  it('toggle flips the document data-theme between dark and light', async () => {
    setClientForTests(stubClient());
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('button', { name: /toggle light\/dark theme/i });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    // Logic: theme === 'light' ? 'dark' : 'light'. So non-'light' -> 'light'.
    await userEvent.click(toggle); // undefined -> 'light'
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(toggle); // 'light' -> 'dark'
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(toggle); // 'dark' -> 'light'
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
