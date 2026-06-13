import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScreen } from '../src/screens/MachinesScreen';
import { setToken } from '../src/api';
import { findCall, jsonRes, makeMachine, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

const fixtures = [
  makeMachine({ id: 'mch_1', display_name: 'worker-1', status: 'running' }),
  makeMachine({ id: 'mch_2', display_name: 'worker-2', status: 'stopped', os_type: 'windows' }),
];

describe('MachinesScreen', () => {
  it('lists machines with their status', async () => {
    stubFetch(() => jsonRes({ machines: fixtures }));
    render(<MachinesScreen />);

    expect(await screen.findByText('worker-1')).toBeInTheDocument();
    expect(screen.getByText('worker-2')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('stops a running machine and refreshes the list', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.includes('/api/machines/mch_1/stop') && init?.method === 'POST') {
        return jsonRes({ ok: true });
      }
      return jsonRes({ machines: fixtures });
    });
    render(<MachinesScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop worker-1' }));

    await waitFor(() => expect(findCall(fetchMock, '/api/machines/mch_1/stop')).toBeDefined());
    // list reloaded after the action
    const listCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/machines'));
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('starts a stopped machine', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.includes('/api/machines/mch_2/start') && init?.method === 'POST') {
        return jsonRes({ ok: true });
      }
      return jsonRes({ machines: fixtures });
    });
    render(<MachinesScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start worker-2' }));

    await waitFor(() => expect(findCall(fetchMock, '/api/machines/mch_2/start')).toBeDefined());
  });

  it('shows the empty state when no machines exist', async () => {
    stubFetch(() => jsonRes({ machines: [] }));
    render(<MachinesScreen />);
    expect(await screen.findByText(/No machines yet/)).toBeInTheDocument();
  });

  it('shows an error with retry when listing fails', async () => {
    let first = true;
    stubFetch(() => {
      if (first) {
        first = false;
        return jsonRes({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Coasty is down' } }, 503);
      }
      return jsonRes({ machines: fixtures });
    });
    render(<MachinesScreen />);

    expect(await screen.findByText('Coasty is down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('worker-1')).toBeInTheDocument();
  });
});
