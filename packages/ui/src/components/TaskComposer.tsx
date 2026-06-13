import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx } from '../cx';
import { Button } from './Button';
import { CostPill } from './CostPill';
import { Icon } from './Icon';

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
 * Delegate-a-task composer styled as a single chat input: an auto-growing task
 * textarea is the focal element, with the machine selector inline at the bottom
 * left and a send button at the bottom right. Submit stays disabled until both a
 * non-empty task and a machine are present. Ctrl/Cmd+Enter submits from the
 * textarea (Enter inserts a newline).
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
  const taskRef = useRef<HTMLTextAreaElement>(null);

  const canSubmit = task.trim().length > 0 && machineId !== '' && !pending;

  // Auto-grow the textarea with its content. The CSS `max-height` on
  // `.oc-composer__input` is the single source of the grow cap — it clamps the
  // rendered height (then the textarea scrolls), so no px constant is needed here.
  useEffect(() => {
    const el = taskRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [task]);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ task: task.trim(), machineId });
  };

  const onTaskKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter submits; a plain Enter inserts a newline (multi-line task).
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={cx('oc-composer', className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={taskRef}
        className="oc-composer__input"
        aria-label="Task"
        rows={1}
        value={task}
        disabled={pending}
        placeholder="Describe a task to delegate…"
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={onTaskKeyDown}
      />
      <div className="oc-composer__toolbar">
        <select
          className="oc-composer__select"
          aria-label="Machine"
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
        <div className="oc-composer__actions">
          {estimateCents !== undefined ? (
            <CostPill cents={estimateCents} variant="estimate" />
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="icon"
            loading={pending}
            disabled={!canSubmit}
            aria-label="Send"
          >
            {pending ? null : <Icon name="send" />}
          </Button>
        </div>
      </div>
    </form>
  );
}
