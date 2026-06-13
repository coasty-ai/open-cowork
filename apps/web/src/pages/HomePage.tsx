/**
 * Delegate a task: a clean, centered single-focus composer. Compose → see the
 * server-computed worst-case estimate → explicitly confirm the cost → run starts
 * → jump to the live run view. On desktop, a "This computer" target runs the
 * LocalExecutor loop instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  CostPill,
  EmptyState,
  ErrorState,
  Icon,
  Logo,
  Modal,
  Spinner,
  TaskComposer,
} from '@open-cowork/ui';
import { getClient } from '../store';
import { formatApiError, type MachineDto } from '../api/client';

const LOCAL_TARGET_ID = '__local__';

export function HomePage() {
  const client = getClient();
  const navigate = useNavigate();
  const [machines, setMachines] = useState<MachineDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingTask, setPendingTask] = useState<{ task: string; machineId: string } | null>(null);
  const [estimateCents, setEstimateCents] = useState<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isDesktop = typeof window !== 'undefined' && window.cowork?.platform === 'desktop';

  const load = async () => {
    setLoadError(null);
    try {
      const [machineRes, estimate] = await Promise.all([
        client.listMachines(),
        client.estimate({ kind: 'run', maxSteps: 25 }),
      ]);
      setMachines(machineRes.machines);
      setEstimateCents(estimate.cents);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const options = useMemo(() => {
    const cloud = (machines ?? [])
      .filter((m) => m.status === 'running')
      .map((m) => ({ id: m.id, label: `${m.display_name} (${m.os_type} cloud VM)` }));
    return isDesktop
      ? [{ id: LOCAL_TARGET_ID, label: 'This computer (local screen)' }, ...cloud]
      : cloud;
  }, [machines, isDesktop]);

  const confirmAndStart = async () => {
    if (!pendingTask) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (pendingTask.machineId === LOCAL_TARGET_ID) {
        if (!window.cowork?.startLocalRun) throw new Error('Local runs need the desktop app');
        const { runId } = await window.cowork.startLocalRun({
          task: pendingTask.task,
          maxSteps: 25,
        });
        navigate(`/runs/${runId}`);
        return;
      }
      const run = await client.createRun({
        machineId: pendingTask.machineId,
        task: pendingTask.task,
        maxSteps: 25,
        confirmCostCents: estimateCents ?? 0,
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setSubmitError(formatApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Pre-content states center in the same frame as the loaded composer, so the
  // page's centered language holds while loading / on error.
  if (loadError)
    return (
      <div className="delegate">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </div>
    );
  if (machines === null)
    return (
      <div className="delegate">
        <Spinner aria-label="Loading" />
      </div>
    );

  return (
    <>
      <div className="delegate">
        <div className="delegate__stack">
          <div className="delegate__header">
            <Logo size={44} />
            <p className="delegate__caption">
              Describe a task in plain language and delegate it to your agent.
            </p>
          </div>

          {options.length === 0 ? (
            <EmptyState
              title="No machine to run on"
              description="Provision a cloud machine first — the agent needs a screen to work on."
              action={
                <Button onClick={() => navigate('/machines')} variant="primary">
                  Go to Machines
                </Button>
              }
            />
          ) : (
            <TaskComposer
              options={options}
              estimateCents={estimateCents}
              pending={submitting}
              onSubmit={(payload) =>
                setPendingTask({ task: payload.task, machineId: payload.machineId })
              }
            />
          )}
        </div>
      </div>

      <Modal
        open={pendingTask !== null}
        onClose={() => setPendingTask(null)}
        title="Confirm cost before starting"
      >
        <div className="stack">
          <p>
            This run is capped at <strong>25 steps</strong>. Worst-case cost:{' '}
            {estimateCents !== undefined ? (
              <CostPill cents={estimateCents} variant="estimate" />
            ) : (
              '…'
            )}
            . You only pay for steps that actually execute.
          </p>
          {pendingTask?.machineId === LOCAL_TARGET_ID ? (
            <p className="notice notice--warning">
              <Icon name="alertTriangle" size={16} className="notice__icon" />
              <span className="notice__body">
                This will control <strong>your own mouse and keyboard</strong>. Move the mouse to a
                screen corner to abort at any time.
              </span>
            </p>
          ) : null}
          {submitError ? <ErrorState message={submitError} /> : null}
          <div className="row">
            <Button onClick={() => void confirmAndStart()} loading={submitting}>
              Start run
            </Button>
            <Button variant="secondary" onClick={() => setPendingTask(null)} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
