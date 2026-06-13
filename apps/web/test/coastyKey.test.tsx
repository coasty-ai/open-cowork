/**
 * Coasty API key setup flow: the login-screen field (demo mode only) and the
 * Settings section. Covers showing/hiding by status, attaching a key on login,
 * a rejected key reverting the just-made session, and the Settings save/clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { CoastyKeyProvider } from '../src/coastyKey';
import { ApiError } from '../src/api/client';
import { LoginPage } from '../src/pages/LoginPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { stubClient } from './helpers';

beforeEach(() => {
  useAuth.setState({ token: null, user: null });
});
afterEach(() => {
  cleanup();
  setClientForTests(null);
  useAuth.setState({ token: null, user: null });
  vi.restoreAllMocks();
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>HOME-STUB</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const DEMO = { configured: false, mode: null, demoMode: true, source: 'demo' } as const;
const FAKE_KEY = 'sk-coasty-test-deadbeef12345678';

describe('LoginPage — Coasty key setup', () => {
  it('offers the key field in demo mode and attaches a valid key on sign-in', async () => {
    const setCoastyKey = vi.fn(async () => ({
      ok: true as const,
      configured: true,
      mode: 'test' as const,
      demoMode: false,
      source: 'runtime' as const,
    }));
    setClientForTests(stubClient({ coastyKeyStatus: vi.fn(async () => DEMO), setCoastyKey }));
    renderLogin();

    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.c');
    await userEvent.type(await screen.findByLabelText(/coasty api key/i), FAKE_KEY);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(setCoastyKey).toHaveBeenCalledWith(FAKE_KEY));
    expect(await screen.findByText('HOME-STUB')).toBeInTheDocument();
  });

  it('signs in without a key (stays in demo) and does not call setCoastyKey', async () => {
    const setCoastyKey = vi.fn();
    setClientForTests(stubClient({ coastyKeyStatus: vi.fn(async () => DEMO), setCoastyKey }));
    renderLogin();

    await screen.findByLabelText(/coasty api key/i); // demo field present
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('HOME-STUB')).toBeInTheDocument();
    expect(setCoastyKey).not.toHaveBeenCalled();
  });

  it('a rejected key reverts the session and keeps the user on login', async () => {
    const setCoastyKey = vi.fn(async () => {
      throw new ApiError(400, 'INVALID_KEY_FORMAT', 'That is not a valid Coasty key.');
    });
    setClientForTests(stubClient({ coastyKeyStatus: vi.fn(async () => DEMO), setCoastyKey }));
    renderLogin();

    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.c');
    await userEvent.type(await screen.findByLabelText(/coasty api key/i), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/not a valid coasty key/i)).toBeInTheDocument();
    expect(screen.queryByText('HOME-STUB')).not.toBeInTheDocument();
    expect(useAuth.getState().token).toBeNull(); // session reverted
  });

  it('hides the key field and shows "connected" when a key is configured', async () => {
    setClientForTests(
      stubClient({
        coastyKeyStatus: vi.fn(async () => ({
          configured: true,
          mode: 'live' as const,
          demoMode: false,
          source: 'env' as const,
        })),
      }),
    );
    renderLogin();
    expect(await screen.findByText(/coasty connected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/coasty api key/i)).not.toBeInTheDocument();
  });
});

describe('SettingsPage — Coasty key section', () => {
  function renderSettings() {
    return render(
      <MemoryRouter>
        <CoastyKeyProvider>
          <SettingsPage />
        </CoastyKeyProvider>
      </MemoryRouter>,
    );
  }

  const CONNECTED_RUNTIME = {
    configured: true,
    mode: 'test' as const,
    demoMode: false,
    source: 'runtime' as const,
  };

  it('shows Demo mode and saves a key', async () => {
    // Settings re-reads status via the shared source after a save, so the stub
    // is stateful: demo until the key is set, connected afterwards.
    let current: typeof DEMO | typeof CONNECTED_RUNTIME = DEMO;
    const setCoastyKey = vi.fn(async () => {
      current = CONNECTED_RUNTIME;
      return { ok: true as const, ...CONNECTED_RUNTIME };
    });
    setClientForTests(stubClient({ coastyKeyStatus: vi.fn(async () => current), setCoastyKey }));
    renderSettings();

    expect(await screen.findByText(/demo mode/i)).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText(/coasty api key/i), FAKE_KEY);
    await userEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(setCoastyKey).toHaveBeenCalledWith(FAKE_KEY));
    expect(await screen.findByText(/connected · test/i)).toBeInTheDocument();
  });

  it('clears a runtime key via Remove key', async () => {
    let current: typeof DEMO | typeof CONNECTED_RUNTIME = CONNECTED_RUNTIME;
    const clearCoastyKey = vi.fn(async () => {
      current = DEMO;
      return DEMO;
    });
    setClientForTests(stubClient({ coastyKeyStatus: vi.fn(async () => current), clearCoastyKey }));
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: /remove key/i }));
    await waitFor(() => expect(clearCoastyKey).toHaveBeenCalled());
    expect(await screen.findByText(/demo mode/i)).toBeInTheDocument();
  });
});
