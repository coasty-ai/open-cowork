import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from '../App';
import { getToken, setToken } from '../src/api';
import { jsonRes, makeRun, makeWallet, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

/** Route every backend endpoint the shell can touch during the journey. */
function stubBackend() {
  return stubFetch((url) => {
    if (url.includes('/api/auth/login')) {
      return jsonRes({
        token: 'tok_app',
        user: { id: 'u_1', email: 'demo@open-cowork.dev', budgetCents: 500 },
      });
    }
    if (url.includes('/events.json')) return jsonRes({ events: [], done: false });
    if (url.includes('/api/runs/r_1')) return jsonRes(makeRun({ id: 'r_1', machineId: null }));
    if (url.endsWith('/api/runs')) return jsonRes({ runs: [makeRun({ id: 'r_1' })] });
    if (url.endsWith('/api/workflows/runs')) return jsonRes({ runs: [] });
    if (url.endsWith('/api/machines')) return jsonRes({ machines: [] });
    if (url.includes('/api/wallet')) return jsonRes(makeWallet());
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('App shell', () => {
  it('logs in, browses tabs, and opens a run detail with back navigation', async () => {
    stubBackend();
    render(<App />);

    // login gate
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'demo@open-cowork.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // runs tab is the default landing screen
    expect(await screen.findByText('Open the dashboard and export the report')).toBeInTheDocument();
    expect(getToken()).toBe('tok_app');
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeInTheDocument();

    // open the run detail overlay (tab bar hides), then go back
    fireEvent.click(screen.getByRole('button', { name: 'Open run r_1' }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Runs' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('tab', { name: 'Runs' })).toBeInTheDocument();

    // switch to the wallet tab
    fireEvent.click(screen.getByRole('tab', { name: 'Wallet' }));
    expect(await screen.findByText('$12.34')).toBeInTheDocument();

    // switch to machines (empty state)
    fireEvent.click(screen.getByRole('tab', { name: 'Machines' }));
    expect(await screen.findByText(/No machines yet/)).toBeInTheDocument();

    // sign out from the wallet tab returns to the login gate
    fireEvent.click(screen.getByRole('tab', { name: 'Wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });
});
