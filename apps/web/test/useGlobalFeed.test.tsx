/**
 * useGlobalFeed: an SSE notification stream surfaces an approval banner with a
 * review link; Dismiss hides it. Stubs global fetch (used by useSse) to emit
 * awaiting_human notifications offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { setClientForTests, useAuth } from '../src/store';
import { useGlobalFeed } from '../src/useGlobalFeed';
import { stubClient, encodeSseFrames, sseStream, type SseFrame } from './helpers';

function stubSse(frames: SseFrame[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: sseStream(encodeSseFrames(frames)),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Tiny harness component that renders the hook's banner.
function FeedHarness() {
  const { banner, offline } = useGlobalFeed();
  return (
    <div>
      {offline ? <span data-testid="offline">offline</span> : null}
      {banner}
    </div>
  );
}

function renderFeed() {
  return render(
    <MemoryRouter>
      <FeedHarness />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuth.setState({ token: 'cwk_t', user: { id: 'u1', email: 'a@b.c', budgetCents: 500 } });
  // useGlobalFeed calls getClient() for url()/authHeaders(); inject the stub.
  setClientForTests(stubClient());
});

afterEach(() => {
  cleanup();
  setClientForTests(null);
  useAuth.setState({ token: null, user: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useGlobalFeed', () => {
  it('renders an approval banner with a review link for a run awaiting_human', async () => {
    stubSse([{ id: 1, event: 'run.awaiting_human', data: { runId: 'r_42', reason: 'captcha' } }]);
    renderFeed();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/waiting for your approval/i);
    expect(banner).toHaveTextContent(/a run is waiting/i);
    const link = screen.getByRole('link', { name: /review it now/i });
    expect(link).toHaveAttribute('href', '/runs/r_42');
  });

  it('links to the workflow-run route for a workflow awaiting_human', async () => {
    stubSse([
      {
        id: 1,
        event: 'workflow.awaiting_human',
        data: { workflowRunId: 'wfr_7', reason: 'approve publish' },
      },
    ]);
    renderFeed();
    await screen.findByRole('status');
    expect(screen.getByText(/a workflow is waiting/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review it now/i })).toHaveAttribute(
      'href',
      '/workflows/runs/wfr_7',
    );
  });

  it('Dismiss hides the banner', async () => {
    stubSse([{ id: 1, event: 'run.awaiting_human', data: { runId: 'r_42' } }]);
    renderFeed();
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('renders no banner when there are no awaiting_human notifications', async () => {
    stubSse([
      { id: 1, event: 'run.status', data: { status: 'running' } },
      { id: 2, event: 'ping', data: {} },
    ]);
    renderFeed();
    // Give the stream time to flush the two non-approval frames.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not subscribe when there is no token', async () => {
    useAuth.setState({ token: null, user: null });
    const fetchMock = stubSse([{ id: 1, event: 'run.awaiting_human', data: { runId: 'r_1' } }]);
    renderFeed();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
