import { useState } from 'react';
import { cx } from '../cx';

/** Execution status of one workflow step. */
export type WorkflowStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * Presentational workflow step node. Apps map the core workflow DSL
 * (task/if/loop/parallel/retry/... steps) into this recursive shape; `children`
 * holds nested bodies/branches flattened for display.
 */
export interface WorkflowStep {
  /** Step id from the DSL. */
  id: string;
  /** DSL step type (`task`, `if`, `loop`, `parallel`, `retry`, ...). */
  type: string;
  /** Human label; falls back to the step id. */
  label?: string;
  /** Execution status; defaults to `pending`. */
  status?: WorkflowStepStatus;
  /** Nested steps (branch/loop/retry bodies). */
  children?: WorkflowStep[];
}

/** Props for {@link WorkflowStepTree}. */
export interface WorkflowStepTreeProps {
  /** Top-level steps in definition order. */
  steps: WorkflowStep[];
  className?: string;
}

interface StepNodeProps {
  step: WorkflowStep;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

function StepNode({ step, collapsed, onToggle }: StepNodeProps) {
  const children = step.children ?? [];
  const hasChildren = children.length > 0;
  const expanded = hasChildren && !collapsed.has(step.id);
  const label = step.label ?? step.id;
  const status = step.status ?? 'pending';

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      className="oc-step-tree__item"
    >
      <div className="oc-step-tree__row">
        {hasChildren ? (
          <button
            type="button"
            className="oc-step-tree__toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            onClick={() => onToggle(step.id)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : null}
        <span
          className={cx('oc-step-tree__dot', `oc-step-tree__dot--${status}`)}
          data-testid={`step-dot-${step.id}`}
          aria-hidden="true"
        />
        <span className="oc-step-tree__label">{label}</span>
        <span className="oc-step-tree__type">{step.type}</span>
      </div>
      {expanded ? (
        <ul role="group">
          {children.map((child) => (
            <StepNode key={child.id} step={child} collapsed={collapsed} onToggle={onToggle} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Collapsible tree view of a workflow definition (`role="tree"`): container
 * nodes get an `aria-expanded` toggle button, every node shows a status dot.
 */
export function WorkflowStepTree({ steps, className }: WorkflowStepTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul role="tree" className={cx('oc-step-tree', className)}>
      {steps.map((step) => (
        <StepNode key={step.id} step={step} collapsed={collapsed} onToggle={toggle} />
      ))}
    </ul>
  );
}
