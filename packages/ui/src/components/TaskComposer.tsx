import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx } from '../cx';
import { Button } from './Button';
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
  /** Disables the form while the create-run request is in flight. */
  pending?: boolean;
  /** Pre-selected machine id. */
  defaultMachineId?: string;
  /** Called with `{ task, machineId }` when the form is submitted. */
  onSubmit: (payload: TaskComposerSubmit) => void;
  className?: string;
}

/**
 * In-house machine selector: a sleek trigger + a custom popover listbox (no
 * native OS dropdown, so it looks identical in both themes). The combobox keeps
 * focus and points at the active option via `aria-activedescendant`. Keyboard:
 * ↑/↓ move, Enter/Space select, Escape closes; click-outside dismisses.
 */
function MachineSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: MachineOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const selected = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const openMenu = () => {
    const idx = options.findIndex((o) => o.id === value);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  };
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o.id);
    }
  };

  return (
    <div className="oc-mselect" ref={rootRef}>
      <button
        type="button"
        className="oc-mselect__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-label="Machine"
        data-placeholder={selected ? undefined : true}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <Icon name="machines" size={15} className="oc-mselect__icon" />
        <span className="oc-mselect__label">{selected?.label ?? 'Select a machine'}</span>
        <Icon name="chevronDown" size={15} className="oc-mselect__chevron" />
      </button>
      {open ? (
        <ul className="oc-mselect__menu" role="listbox" id={listboxId} aria-label="Machines">
          {options.map((o, i) => (
            <li
              key={o.id}
              id={optionId(i)}
              role="option"
              aria-selected={o.id === value}
              className="oc-mselect__option"
              data-active={i === active || undefined}
              data-selected={o.id === value || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.id)}
            >
              <span className="oc-mselect__option-label">{o.label}</span>
              {o.id === value ? (
                <Icon name="check" size={15} className="oc-mselect__check" />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Delegate-a-task composer styled as a single chat input: an auto-growing task
 * textarea is the focal element, with the in-house machine selector inline at
 * the bottom left and a send button at the bottom right. Submit stays disabled
 * until both a non-empty task and a machine are present. Ctrl/Cmd+Enter submits
 * from the textarea (Enter inserts a newline).
 */
export function TaskComposer({
  options,
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
        <MachineSelect
          options={options}
          value={machineId}
          onChange={setMachineId}
          disabled={pending}
        />
        <div className="oc-composer__actions">
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
