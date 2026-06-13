import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RunDetailScreen } from '../src/screens/RunDetailScreen';
import { setToken, type RunDto, type RunEventDto } from '../src/api';
import {
  bodyOf,
  calledUrls,
  findCall,
  jsonRes,
  makeRun,
  stubFetch,
  type FetchMock,
} from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setToken(null);
});

/** Flush pending fake timers + microtasks inside act. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function event(seq: number, type: string, data: Record<string, unknown>): RunEventDto {
  return { seq, type, data, createdAt: '2026-06-11T10:00:01.000Z' };
}

interface RouterState {
  run: RunDto;
  events: RunEventDto[];
}

/** Stub the detail endpoints: getRun, events.json cursor, screenshot, cancel, resume. */
function stubDetailFetch(state: RouterState): FetchMock {
  return stubFetch((url, init) => {
    if (url.includes('/events.json')) {
      const after = Number(new URL(url).searchParams.get('after') ?? '0');
      const events = state.events.filter((e) => e.seq > after);
      return jsonRes({ events, done: events.some((e) => e.type === 'done') });
    }
    if (url.includes('/screenshot')) {
      return jsonRes({
        image_b64: 'iVBORw0KGgoAAAANSUhEUg==',
        width: 1280,
        height: 720,
        captured_at: '2026-06-11T10:00:02.000Z',
      });
    }
    if (url.endsWith('/cancel') && init?.method === 'POST') {
      state.run = { ...state.run, status: 'cancelled', finishedAt: '2026-06-11T10:05:00.000Z' };
      return jsonRes(state.run);
    }
    if (url.endsWith('/resume') && init?.method === 'POST') {
      state.run = { ...state.run, status: 'running', awaitingHumanReason: null };
      return jsonRes(state.run);
    }
    if (/\/api\/runs\/[^/]+$/.test(url)) return jsonRes(state.run);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('RunDetailScreen', () => {
  it('appends timeline events through the after-cursor and polls the screen frame', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({ id: 'r_1', status: 'running' }),
      events: [event(1, 'status', { status: 'running' }), event(2, 'step', { steps_completed: 1 })],
    };
    const fetchMock = stubDetailFetch(state);

    render(<RunDetailScreen runId="r_1" onBack={vi.fn()} />);
    await flush();

    expect(screen.getByText('Open the dashboard and export the report')).toBeInTheDocument();
    expect(screen.getByText('#1 status')).toBeInTheDocument();
    expect(screen.getByText('#2 step')).toBeInTheDocument();
    // Cloud run + running -> the machine screen frame is fetched and rendered.
    expect(findCall(fetchMock, '/api/machines/mch_test_1/screenshot')).toBeDefined();
    expect(screen.getByLabelText('Machine screen')).toBeInTheDocument();

    // New upstream event lands; the next 2s poll must ask for seq > 2 only.
    state.events.push(event(3, 'step', { steps_completed: 2 }));
    await flush(2000);

    expect(screen.getByText('#3 step')).toBeInTheDocument();
    // Append-only: earlier events were not refetched or duplicated.
    expect(screen.getAllByText('#1 status')).toHaveLength(1);
    const eventUrls = calledUrls(fetchMock).filter((u) => u.includes('/events.json'));
    expect(eventUrls[0]).toContain('after=0');
    expect(eventUrls[eventUrls.length - 1]).toContain('after=2');
  });

  it('approves an awaiting_human run with the note via resumeRun', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({
        id: 'r_1',
        status: 'awaiting_human',
        machineId: null,
        awaitingHumanReason: 'Send the email to everyone?',
      }),
      events: [],
    };
    const fetchMock = stubDetailFetch(state);

    render(<RunDetailScreen runId="r_1" onBack={vi.fn()} />);
    await flush();

    expect(screen.getByText('Send the email to everyone?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Approval note'), {
      target: { value: 'Yes — ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await flush();

    const call = findCall(fetchMock, '/api/runs/r_1/resume');
    expect(call).toBeDefined();
    expect(bodyOf(call!.init)).toEqual({ note: 'Yes — ship it' });
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('rejects an awaiting_human run via cancelRun', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({ id: 'r_1', status: 'awaiting_human', machineId: null }),
      events: [],
    };
    const fetchMock = stubDetailFetch(state);

    render(<RunDetailScreen runId="r_1" onBack={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await flush();

    expect(findCall(fetchMock, '/api/runs/r_1/cancel')).toBeDefined();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('cancels an active run from the Cancel button', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({ id: 'r_1', status: 'running', machineId: null }),
      events: [],
    };
    const fetchMock = stubDetailFetch(state);

    render(<RunDetailScreen runId="r_1" onBack={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await flush();

    expect(findCall(fetchMock, '/api/runs/r_1/cancel')).toBeDefined();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows the final cost line for a finished run and hides the controls', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({
        id: 'r_1',
        status: 'succeeded',
        costCents: 123,
        machineId: null,
        finishedAt: '2026-06-11T10:10:00.000Z',
      }),
      events: [event(1, 'done', { status: 'succeeded' })],
    };
    stubDetailFetch(state);

    render(<RunDetailScreen runId="r_1" onBack={vi.fn()} />);
    await flush();

    expect(screen.getByText('Final cost: $1.23')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('navigates back with the back button', async () => {
    vi.useFakeTimers();
    const state: RouterState = {
      run: makeRun({ id: 'r_1', status: 'succeeded', machineId: null }),
      events: [],
    };
    stubDetailFetch(state);
    const onBack = vi.fn();

    render(<RunDetailScreen runId="r_1" onBack={onBack} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
