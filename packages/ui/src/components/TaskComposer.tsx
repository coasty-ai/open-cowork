import { useId, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx } from '../cx';
import { Button } from './Button';
import { CostPill } from './CostPill';

/** One selectable machine target. */
export interface MachineOption {
  id: string;
  label: string;
}

/** Payload emitted by {@link TaskComposer} on submit. */
export interface TaskComposerSubmit {
  /** Trimmed task text. */
  task: string;
  /** Selected machine id. */
  machineId: string;
}

/** Props for {@link TaskComposer}. */
export interface TaskComposerProps {
  /** Machines the user can target. */
  options: MachineOption[];
  /** Server-computed cost estimate in cents; shown as an estimate CostPill. */
  estimateCents?: number;
  /** Disables the form while the create-run request is in flight. */
  pending?: boolean;
  /** Pre-selected machine id. */
  defaultMachineId?: string;
  /** Called with `{ task, machineId }` when the form is submitted. */
  onSubmit: (payload: TaskComposerSubmit) => void;
  className?: string;
}

/**
 * Delegate-a-task form: task textarea, machine selector, optional cost
 * estimate pill, and a Submit button that stays disabled until both a
 * non-empty task and a machine are present. Ctrl+Enter submits from the
 * textarea.
 */
export function TaskComposer({
  options,
  estimateCents,
  pending = false,
  defaultMachineId,
  onSubmit,
  className,
}: TaskComposerProps) {
  const [task, setTask] = useState('');
  const [machineId, setMachineId] = useState(defaultMachineId ?? '');
  const taskId = useId();
  const machineSelectId = useId();

  const canSubmit = task.trim().length > 0 && machineId !== '' && !pending;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ task: task.trim(), machineId });
  };

  const onTaskKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={cx('oc-task-composer', className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="oc-task-composer__label" htmlFor={taskId}>
        Task
      </label>
      <textarea
        id={taskId}
        value={task}
        disabled={pending}
        placeholder="Describe what the agent should do"
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={onTaskKeyDown}
      />
      <label className="oc-task-composer__label" htmlFor={machineSelectId}>
        Machine
      </label>
      <select
        id={machineSelectId}
        value={machineId}
        disabled={pending}
        onChange={(event) => setMachineId(event.target.value)}
      >
        <option value="">Select a machine</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="oc-task-composer__footer">
        {estimateCents !== undefined ? <CostPill cents={estimateCents} variant="estimate" /> : null}
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          Submit
        </Button>
      </div>
    </form>
  );
}
