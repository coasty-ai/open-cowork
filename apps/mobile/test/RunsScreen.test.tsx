import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunsScreen } from '../src/screens/RunsScreen';
import { setToken } from '../src/api';
import { jsonRes, makeRun, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('RunsScreen', () => {
  it('renders the runs from the backend with status chips', async () => {
    stubFetch((url) => {
      if (url.includes('/api/runs')) {
        return jsonRes({
          runs: [
            makeRun({ id: 'r_1', status: 'running', task: 'Export the report' }),
            makeRun({
              id: 'r_2',
              status: 'succeeded',
              task: 'Book the meeting room',
              costCents: 80,
            }),
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<RunsScreen onOpenRun={vi.fn()} />);

    expect(await screen.findByText('Export the report')).toBeInTheDocument();
    expect(screen.getByText('Book the meeting room')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.queryByText('A run needs your approval')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no runs', async () => {
    stubFetch(() => jsonRes({ runs: [] }));
    render(<RunsScreen onOpenRun={vi.fn()} />);
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });

  it('shows the awaiting-approval banner and opens that run on tap', async () => {
    stubFetch(() =>
      jsonRes({
        runs: [
          makeRun({ id: 'r_ok', status: 'running' }),
          makeRun({
            id: 'r_wait',
            status: 'awaiting_human',
            task: 'Confirm sending the email',
            awaitingHumanReason: 'About to send to the whole company',
          }),
        ],
      }),
    );
    const onOpenRun = vi.fn();
    render(<RunsScreen onOpenRun={onOpenRun} />);

    const banner = await screen.findByRole('button', { name: 'A run needs your approval' });
    fireEvent.click(banner);
    expect(onOpenRun).toHaveBeenCalledWith('r_wait');
  });

  it('opens a run when its card is tapped', async () => {
    stubFetch(() => jsonRes({ runs: [makeRun({ id: 'r_7' })] }));
    const onOpenRun = vi.fn();
    render(<RunsScreen onOpenRun={onOpenRun} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open run r_7' }));
    expect(onOpenRun).toHaveBeenCalledWith('r_7');
  });

  it('shows an error note with retry when the backend is unreachable', async () => {
    let failures = 0;
    stubFetch(() => {
      if (failures === 0) {
        failures += 1;
        throw new TypeError('fetch failed');
      }
      return jsonRes({ runs: [makeRun({ id: 'r_back', task: 'Recovered task' })] });
    });
    render(<RunsScreen onOpenRun={vi.fn()} />);

    expect(await screen.findByText('Cannot reach the open-cowork backend')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered task')).toBeInTheDocument();
  });
});
