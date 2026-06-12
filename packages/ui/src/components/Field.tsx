import { useId } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../cx';

/** Values handed to the {@link Field} children render-prop. */
export interface FieldRenderProps {
  /** Generated id; assign it to the control so the label's `htmlFor` matches. */
  id: string;
  /** Space-separated ids of the hint/error text, for `aria-describedby`. */
  describedBy: string | undefined;
  /** True when an `error` is present; assign to `aria-invalid`. */
  invalid: boolean;
}

/** Props for {@link Field}. */
export interface FieldProps {
  /** Visible label text, associated with the control via `htmlFor`. */
  label: string;
  /** Shows a required marker next to the label. */
  required?: boolean;
  /** Validation error; rendered as an alert and wired via `aria-describedby`. */
  error?: string;
  /** Optional help text, also wired via `aria-describedby`. */
  hint?: string;
  className?: string;
  /**
   * Render-prop receiving `{ id, describedBy, invalid }`; spread those onto
   * your input/textarea/select so the label, hint, and error are all wired.
   */
  children: (props: FieldRenderProps) => ReactNode;
}

/**
 * Form field wrapper: label, optional hint, optional error, and the wiring
 * (`htmlFor`/`id`, `aria-describedby`) handed to the control via render-prop.
 */
export function Field({ label, required = false, error, hint, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cx('oc-field', error ? 'oc-field--invalid' : false, className)}>
      <label className="oc-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="oc-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} className="oc-field__hint">
          {hint}
        </p>
      ) : null}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} role="alert" className="oc-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
