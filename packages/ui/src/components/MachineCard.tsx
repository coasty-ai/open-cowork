import { useEffect, useRef, useState } from 'react';
import { cx } from '../cx';
import { Badge } from './Badge';
import type { BadgeTone } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { formatCents } from './CostPill';

/**
 * Machine lifecycle states, mirroring the Coasty machines API. Defined
 * locally (no `@open-cowork/core` import); apps map core machine objects
 * into {@link MachineSummary}.
 */
export type MachineStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'restarting'
  | 'stopped'
  | 'suspended_for_billing'
  | 'terminated'
  | 'error';

/** Minimal machine shape rendered by {@link MachineCard}. */
export interface MachineSummary {
  id: string;
  displayName: string;
  status: MachineStatus;
  osType: 'linux' | 'windows';
  /** Hourly runtime rate in USD cents (Linux 5, Windows 9, stopped 1). */
  centsPerHour: number;
}

/** Props for {@link MachineCard}. */
export interface MachineCardProps {
  machine: MachineSummary;
  /** Called with the machine id. Enabled only while `stopped`. */
  onStart?: (id: string) => void;
  /** Called with the machine id. Enabled only while `running`. */
  onStop?: (id: string) => void;
  /** Called with the machine id after the two-click confirmation. */
  onTerminate?: (id: string) => void;
  className?: string;
}

const STATUS_TONE: Record<MachineStatus, BadgeTone> = {
  creating: 'info',
  starting: 'info',
  running: 'success',
  stopping: 'info',
  restarting: 'info',
  stopped: 'neutral',
  suspended_for_billing: 'warning',
  terminated: 'neutral',
  error: 'danger',
};

const STATUS_LABEL: Record<MachineStatus, string> = {
  creating: 'Creating',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  restarting: 'Restarting',
  stopped: 'Stopped',
  suspended_for_billing: 'Suspended (billing)',
  terminated: 'Terminated',
  error: 'Error',
};

/** How long the armed Terminate button stays armed before reverting. */
const TERMINATE_ARM_MS = 3000;

/**
 * Machine summary card with lifecycle controls.
 *
 * - Start is enabled only while `stopped`; Stop only while `running`.
 * - Terminate uses a two-click arm pattern: the first click changes the
 *   button to "Confirm terminate?" for 3 seconds; a second click within that
 *   window fires `onTerminate`, otherwise the button disarms.
 */
export function MachineCard({
  machine,
  onStart,
  onStop,
  onTerminate,
  className,
}: MachineCardProps) {
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (disarmTimer.current !== null) clearTimeout(disarmTimer.current);
    },
    [],
  );

  const handleTerminate = () => {
    if (!armed) {
      setArmed(true);
      if (disarmTimer.current !== null) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmed(false), TERMINATE_ARM_MS);
      return;
    }
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setArmed(false);
    onTerminate?.(machine.id);
  };

  return (
    <Card title={machine.displayName} className={cx('oc-machine-card', className)}>
      <div className="oc-machine-card__meta">
        <Badge tone={STATUS_TONE[machine.status]}>{STATUS_LABEL[machine.status]}</Badge>
        <span className="oc-machine-card__os">
          {machine.osType === 'windows' ? 'Windows' : 'Linux'}
        </span>
        <span className="oc-machine-card__rate">{formatCents(machine.centsPerHour)}/hr</span>
      </div>
      <div className="oc-machine-card__actions">
        <Button
          size="sm"
          disabled={machine.status !== 'stopped'}
          onClick={() => onStart?.(machine.id)}
        >
          Start
        </Button>
        <Button
          size="sm"
          disabled={machine.status !== 'running'}
          onClick={() => onStop?.(machine.id)}
        >
          Stop
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={machine.status === 'terminated'}
          onClick={handleTerminate}
        >
          {armed ? 'Confirm terminate?' : 'Terminate'}
        </Button>
      </div>
    </Card>
  );
}
