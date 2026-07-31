/**
 * The managed-task (submit-and-forget) client surface.
 *
 * Two things are load-bearing and easy to break silently:
 *   1. the managed target must confirm a `kind: 'task'` estimate, because a run
 *      estimate omits ephemeral machine runtime and the backend will reject it;
 *   2. once a task's machine is destroyed, the run view must fall back to the
 *      stored model-input frames instead of showing an empty screen forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setClientForTests } from '../src/store';
import { HomePage } from '../src/pages/HomePage';
import { RunDetailPage } from '../src/pages/RunDetailPage';
import { stubClient } from './helpers';
import type { RunDto } from '../src/api/client';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:id" element={<div>run page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRun(id = 'r_task') {
  return render(
    <MemoryRouter initialEntries={[`/runs/${id}`]}>
      <Routes>
        <Route path="/runs/:id" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const taskRun = (over: Partial<RunDto> = {}): RunDto =>
  ({
    id: 'r_task',
    kind: 'task',
    machineId: null,
    task: 'Download the newest invoice',
    status: 'succeeded',
    cuaVersion: 'v5',
    maxSteps: 150,
    budgetCents: 500,
    costCents: 15,
    stepsCompleted: 3,
    result: { passed: true, summary: 'Done' },
    error: null,
    awaitingHumanReason: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:01:00.000Z',
    machine: {
      mode: 'automatic',
      status: 'released',
      id: 'mch_test_1',
      cleanup: 'always',
      cleanup_status: 'terminated',
    },
    deadlineSeconds: 3600,
    actionPolicy: null,
    ...over,
  }) as RunDto;

async function delegateToManaged(): Promise<void> {
  await userEvent.type(await screen.findByLabelText(/task/i), 'Download the invoices');
  await userEvent.click(screen.getByRole('combobox', { name: 'Machine' }));
  await userEvent.click(await screen.findByRole('option', { name: /coasty-managed/i }));
  await userEvent.click(screen.getByRole('button', { name: /delegate|run|start|submit|send/i }));
}

describe('HomePage — managed task target', () => {
  it('offers the managed target first, before any cloud machine', async () => {
    setClientForTests(stubClient());
    renderHome();
    await userEvent.click(await screen.findByRole('combobox', { name: 'Machine' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toMatch(/coasty-managed/i);
    expect(options.some((o) => /worker-1/.test(o))).toBe(true);
  });

  it('confirms a TASK estimate, not a run estimate', async () => {
    // Using `kind: 'run'` here would under-quote by the machine runtime and the
    // backend's handshake would reject the create with ESTIMATE_CHANGED.
    const client = stubClient({
      estimate: vi.fn(async () => ({ kind: 'task', cents: 55, breakdown: {} })),
      createTask: vi.fn(async () => taskRun({ id: 'r_new', status: 'queued' })),
    });
    setClientForTests(client);
    renderHome();
    await delegateToManaged();
    await screen.findByRole('dialog', { name: /ready to start/i });
    await userEvent.click(screen.getByRole('button', { name: /start run/i }));

    await waitFor(() => expect(client.createTask).toHaveBeenCalledTimes(1));
    const estimateArg = (client.estimate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      kind: string;
      maxSteps: number;
    };
    expect(estimateArg.kind).toBe('task');
    expect(estimateArg.maxSteps).toBe(25);

    const createArg = (client.createTask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      confirmCostCents: number;
      maxSteps: number;
    };
    expect(createArg.confirmCostCents).toBe(55);
    expect(createArg.maxSteps).toBe(25);
    // A managed task has no machine to name.
    expect(createArg).not.toHaveProperty('machineId');
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it('warns that a managed task cannot be approved or resumed mid-run', async () => {
    setClientForTests(stubClient({ createTask: vi.fn(async () => taskRun()) }));
    renderHome();
    await delegateToManaged();
    const dialog = await screen.findByRole('dialog', { name: /ready to start/i });
    expect(dialog).toHaveTextContent(/fully autonomously/i);
    expect(dialog).toHaveTextContent(/never pauses/i);
    // Still no price in front of the user.
    expect(dialog).not.toHaveTextContent('$');
  });

  it('picks the ordinary run path for a real cloud machine', async () => {
    const client = stubClient();
    setClientForTests(client);
    renderHome();
    await userEvent.type(await screen.findByLabelText(/task/i), 'Do the thing');
    await userEvent.click(screen.getByRole('combobox', { name: 'Machine' }));
    await userEvent.click(await screen.findByRole('option', { name: /worker-1/ }));
    await userEvent.click(screen.getByRole('button', { name: /delegate|run|start|submit|send/i }));
    await screen.findByRole('dialog', { name: /ready to start/i });
    await userEvent.click(screen.getByRole('button', { name: /start run/i }));

    await waitFor(() => expect(client.createRun).toHaveBeenCalledTimes(1));
    expect(client.createTask).not.toHaveBeenCalled();
    const estimateArg = (client.estimate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      kind: string;
    };
    expect(estimateArg.kind).toBe('run');
  });
});

describe('RunDetailPage — managed machine lifecycle', () => {
  it('says the machine was shut down once cleanup terminated', async () => {
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () => taskRun()),
        listRunScreenshots: vi.fn(async () => ({ object: 'list', data: [], has_more: false })),
      }),
    );
    renderRun();
    expect(await screen.findByText(/machine was shut down/i)).toBeInTheDocument();
  });

  it('does NOT claim the machine is gone while cleanup is still retrying', async () => {
    // Task completion is not proof of provider termination — saying otherwise
    // would be a lie the user cannot detect.
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () =>
          taskRun({
            machine: {
              mode: 'automatic',
              status: 'released',
              id: 'mch_test_1',
              cleanup: 'always',
              cleanup_status: 'retrying',
            },
          }),
        ),
        listRunScreenshots: vi.fn(async () => ({ object: 'list', data: [], has_more: false })),
      }),
    );
    renderRun();
    expect(await screen.findByText(/being retried/i)).toBeInTheDocument();
    expect(screen.queryByText(/machine was shut down/i)).not.toBeInTheDocument();
  });

  it('reports provisioning while the machine is still being created', async () => {
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () =>
          taskRun({
            status: 'queued',
            finishedAt: null,
            machine: {
              mode: 'automatic',
              status: 'provisioning',
              id: null,
              cleanup: 'always',
              cleanup_status: 'pending',
            },
          }),
        ),
        listRunScreenshots: vi.fn(async () => ({ object: 'list', data: [], has_more: false })),
      }),
    );
    renderRun();
    expect(await screen.findByText(/provisioning a fresh machine/i)).toBeInTheDocument();
  });

  it('falls back to the LAST stored model frame once the machine is destroyed', async () => {
    // The VM is gone, so machineScreenshot would 404. The stored frames are the
    // only surviving evidence — and it must be the newest one, not the oldest.
    const listRunScreenshots = vi.fn(
      async (_id: string, opts: { includeImage?: boolean; afterIndex?: number } = {}) => {
        if (!opts.includeImage) {
          return {
            object: 'list' as const,
            data: [
              { index: 0, attempt: 1, step: 1 },
              { index: 1, attempt: 1, step: 2 },
              { index: 2, attempt: 1, step: 3 },
            ].map((f) => ({
              ...f,
              taken_at: '2026-07-30T00:00:00.000Z',
              width: 1280,
              height: 720,
              mime_type: 'image/png',
              size_bytes: 10,
              sha256: 'x',
              degraded: false,
              encrypted_at_rest: true,
            })),
            has_more: false,
          };
        }
        return {
          object: 'list' as const,
          data: [
            {
              index: 2,
              attempt: 1,
              step: 3,
              taken_at: '2026-07-30T00:00:30.000Z',
              width: 1280,
              height: 720,
              mime_type: 'image/png',
              size_bytes: 10,
              sha256: 'x',
              degraded: false,
              encrypted_at_rest: true,
              image_b64: 'TEVWSVRBVEU=',
            },
          ],
          has_more: false,
        };
      },
    );
    const machineScreenshot = vi.fn(async () => {
      throw new Error('machine is gone');
    });
    setClientForTests(
      stubClient({ getRun: vi.fn(async () => taskRun()), listRunScreenshots, machineScreenshot }),
    );
    renderRun();

    await waitFor(() => expect(listRunScreenshots).toHaveBeenCalled());
    // It asked for the frame AFTER index 1 — i.e. the last one.
    await waitFor(() => {
      const imageCall = listRunScreenshots.mock.calls.find((c) => c[1]?.includeImage);
      expect(imageCall?.[1]?.afterIndex).toBe(1);
    });
    const img = await screen.findByAltText(/machine screen/i);
    expect(img).toHaveAttribute('src', expect.stringContaining('TEVWSVRBVEU='));
    // A destroyed machine must never be polled for a live screenshot.
    expect(machineScreenshot).not.toHaveBeenCalled();
  });

  it('omits afterIndex entirely when the run produced a single frame', async () => {
    // `after_index` is exclusive and the backend rejects a negative value, so
    // index 0 has to be requested by omitting the cursor, not by sending -1.
    const listRunScreenshots = vi.fn(
      async (_id: string, opts: { includeImage?: boolean } = {}) => ({
        object: 'list' as const,
        data: [
          {
            index: 0,
            attempt: 1,
            step: 1,
            taken_at: '2026-07-30T00:00:00.000Z',
            width: 1280,
            height: 720,
            mime_type: 'image/png',
            size_bytes: 10,
            sha256: 'x',
            degraded: false,
            encrypted_at_rest: true,
            ...(opts.includeImage ? { image_b64: 'T05FRlJBTUU=' } : {}),
          },
        ],
        has_more: false,
      }),
    );
    setClientForTests(stubClient({ getRun: vi.fn(async () => taskRun()), listRunScreenshots }));
    renderRun();

    await waitFor(() => {
      const imageCall = listRunScreenshots.mock.calls.find((c) => c[1]?.includeImage);
      expect(imageCall).toBeDefined();
      expect(imageCall?.[1]).not.toHaveProperty('afterIndex');
    });
  });

  it('shows no note at all for an ordinary cloud run', async () => {
    setClientForTests(
      stubClient({
        getRun: vi.fn(async () => taskRun({ kind: 'coasty', machine: null, machineId: 'm1' })),
      }),
    );
    renderRun();
    await screen.findByText(/download the newest invoice/i);
    expect(screen.queryByText(/machine was shut down/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provisioning a fresh machine/i)).not.toBeInTheDocument();
  });
});
