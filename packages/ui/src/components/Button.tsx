import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../cx';
import { Spinner } from './Spinner';

/** Visual style of a {@link Button}. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Size of a {@link Button}. */
export type ButtonSize = 'sm' | 'md';

/** Props for {@link Button}. Extends native button attributes. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant. Defaults to `secondary`. */
  variant?: ButtonVariant;
  /** Size. Defaults to `md`. */
  size?: ButtonSize;
  /**
   * When true, renders an inline spinner, sets `aria-busy`, and disables the
   * button so an in-flight action cannot be re-triggered.
   */
  loading?: boolean;
}

/**
 * The standard action button. `type` defaults to `"button"` so buttons inside
 * forms never submit accidentally.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('oc-button', `oc-button--${variant}`, `oc-button--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" /> : null}
      <span className="oc-button__label">{children}</span>
    </button>
  );
}
