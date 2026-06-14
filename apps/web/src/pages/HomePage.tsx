/**
 * Delegate a task: a clean, centered single-focus composer. Compose → a friendly
 * "ready to start?" confirm where you can set how many steps the agent may take →
 * run starts → jump to the live run view. On desktop, a "This computer" target
 * runs the LocalExecutor loop instead. The confirm step still echoes the
 * server's worst-case estimate back to the backend (the anti-surprise handshake)
 * but never puts a price in front of you.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Logo,
  Modal,
  Spinner,
  TaskComposer,
} from '@open-cowork/ui';
import { getClient } from '../store';
import {
  ApiError,
  formatApiError,
  type CoworkProviderStatus,
  type MachineDto,
} from '../api/client';

const LOCAL_TARGET_ID = '__local__';
const STEP_DEFAULT = 25;
const STEP_MIN = 1;
const STEP_MAX = 1000;
const STEP_NUDGE = 5;

/** Keep a typed/nudged step count inside the range the backend accepts. */
const clampSteps = (n: number) =>
  Math.max(STEP_MIN, Math.min(STEP_MAX, Math.round(Number.isFinite(n) ? n : STEP_DEFAULT)));

export function HomePage() {
  const client = getClient();
  const navigate = useNavigate();
  const [machines, setMachines] = useState<MachineDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screens, setScreens] = useState<
    { id: number; label: string; primary: boolean; current: boolean }[]
  >([]);
  const [provider, setProvider] = useState<CoworkProviderStatus | null>(null);
  const [pendingTask, setPendingTask] = useState<{
    task: string;
    machineId: string;
    screenId?: string;
  } | null>(null);
  const [maxSteps, setMaxSteps] = useState(STEP_DEFAULT);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isDesktop = typeof window !== 'undefined' && window.cowork?.platform === 'desktop';
  // Desktop drives the local screen; web targets remote cloud machines.
  const subtitle = isDesktop ? 'I will work on this computer' : 'I can work on remote computers';

  const load = async () => {
    setLoadError(null);
    try {
      const machineRes = await client.listMachines();
      setMachines(machineRes.machines);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // Desktop: enumerate the monitors so the user can pick which screen the local
  // agent drives (defaults to the screen the app window is on).
  useEffect(() => {
    if (!isDesktop || !window.cowork?.listScreens) return;
    void window.cowork
      .listScreens()
      .then(setScreens)
      .catch(() => setScreens([]));
  }, [isDesktop]);

  // Desktop: which LLM local runs use (Coasty default, or a configured BYO model).
  useEffect(() => {
    if (!isDesktop || !window.cowork?.getProvider) return;
    void window.cowork
      .getProvider()
      .then(setProvider)
      .catch(() => setProvider(null));
  }, [isDesktop]);

  const options = useMemo(() => {
    const cloud = (machines ?? [])
      .filter((m) => m.status === 'running')
      .map((m) => ({ id: m.id, label: `${m.display_name} (${m.os_type} cloud VM)` }));
    return isDesktop
      ? [{ id: LOCAL_TARGET_ID, label: 'This computer (local screen)', local: true }, ...cloud]
      : cloud;
  }, [machines, isDesktop]);

  const screenOptions = useMemo(
    () => screens.map((s) => ({ id: String(s.id), label: s.label })),
    [screens],
  );
  const defaultScreenId = useMemo(() => {
    const pick = screens.find((s) => s.current) ?? screens.find((s) => s.primary) ?? screens[0];
    return pick ? String(pick.id) : undefined;
  }, [screens]);

  const confirmAndStart = async () => {
    if (!pendingTask) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (pendingTask.machineId === LOCAL_TARGET_ID) {
        if (!window.cowork?.startLocalRun) throw new Error('Local runs need the desktop app');
        const { runId } = await window.cowork.startLocalRun({
          task: pendingTask.task,
          maxSteps,
          // The screen the user picked (undefined → the app window's screen).
          displayId: pendingTask.screenId ? Number(pendingTask.screenId) : undefined,
        });
        navigate(`/runs/${runId}`);
        return;
      }
      // The backend requires confirmCostCents to echo its current worst-case for
      // this step count (anti-surprise handshake) — compute it, but never show it.
      const estimate = await client.estimate({ kind: 'run', maxSteps });
      const run = await client.createRun({
        machineId: pendingTask.machineId,
        task: pendingTask.task,
        maxSteps,
        confirmCostCents: estimate.cents,
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      // Too many steps for this account → a cost-free, actionable nudge.
      if (err instanceof ApiError && err.code === 'BUDGET_EXCEEDED') {
        const suggested = (err.details as { suggestedMaxSteps?: number } | undefined)
          ?.suggestedMaxSteps;
        setSubmitError(
          suggested
            ? `That's more steps than your account allows for one run — try ${suggested} or fewer.`
            : "That's more steps than your account allows for one run — try fewer.",
        );
      } else {
        setSubmitError(formatApiError(err));
      }
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

  const isLocalPending = pendingTask?.machineId === LOCAL_TARGET_ID;

  return (
    <>
      <div className="delegate">
        <div className="delegate__stack">
          <div className="delegate__header">
            <Logo mark={false} size={44} />
            <p className="delegate__caption">{subtitle}</p>
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
              pending={submitting}
              screenOptions={screenOptions}
              defaultScreenId={defaultScreenId}
              onSubmit={(payload) =>
                setPendingTask({
                  task: payload.task,
                  machineId: payload.machineId,
                  screenId: payload.screenId,
                })
              }
            />
          )}

          {isDesktop && provider && !provider.isDefault ? (
            <p className="delegate__provider" role="status">
              <Icon name="alertTriangle" size={14} className="notice__icon" />
              Local runs use <strong>{provider.label ?? provider.kind}</strong> — a third-party LLM,
              not Coasty.
            </p>
          ) : null}
        </div>
      </div>

      <Modal
        open={pendingTask !== null}
        onClose={() => setPendingTask(null)}
        title="Ready to start?"
      >
        <div className="stack run-confirm">
          <p className="run-confirm__lede">
            I’ll work through this {isLocalPending ? 'on this computer ' : ''}step by step and pause
            for you whenever I need a decision.
          </p>

          <div className="run-confirm__steps">
            <div className="run-confirm__steps-head">
              <span className="run-confirm__steps-label">Step limit</span>
              <span className="run-confirm__steps-hint">
                I’ll stop automatically when I reach it
              </span>
            </div>
            <div className="oc-stepper">
              <button
                type="button"
                className="oc-stepper__btn"
                aria-label="Fewer steps"
                onClick={() => setMaxSteps((n) => clampSteps(n - STEP_NUDGE))}
                disabled={submitting || maxSteps <= STEP_MIN}
              >
                −
              </button>
              <input
                className="oc-stepper__input"
                type="number"
                inputMode="numeric"
                min={STEP_MIN}
                max={STEP_MAX}
                aria-label="Maximum steps"
                value={maxSteps}
                onChange={(e) => setMaxSteps(clampSteps(Number(e.target.value)))}
                disabled={submitting}
              />
              <button
                type="button"
                className="oc-stepper__btn"
                aria-label="More steps"
                onClick={() => setMaxSteps((n) => clampSteps(n + STEP_NUDGE))}
                disabled={submitting || maxSteps >= STEP_MAX}
              >
                +
              </button>
            </div>
          </div>

          {isLocalPending ? (
            <p className="notice notice--warning">
              <Icon name="alertTriangle" size={16} className="notice__icon" />
              <span className="notice__body">
                This will control <strong>your own mouse and keyboard</strong>. Move the mouse to a
                screen corner to abort at any time.
              </span>
            </p>
          ) : null}
          {isLocalPending && provider && !provider.isDefault ? (
            <p className="notice notice--warning">
              <Icon name="alertTriangle" size={16} className="notice__icon" />
              <span className="notice__body">
                This run uses <strong>{provider.label ?? provider.kind}</strong> — a third-party
                LLM, not Coasty. Your screenshots and prompts are sent to that provider.
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
