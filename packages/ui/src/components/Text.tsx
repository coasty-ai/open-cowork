import type { ElementType, ReactNode } from 'react';
import { cx } from '../cx';

/** Non-heading text role. */
export type TextVariant = 'body' | 'caption' | 'muted' | 'strong';

/** Props for {@link Text}. */
export interface TextProps {
  /** Text role. Default `body`. */
  variant?: TextVariant;
  /** Override the element. Defaults to `p` for `caption`, else `span`. */
  as?: ElementType;
  children: ReactNode;
  className?: string;
}

const VARIANT_CLASS: Record<TextVariant, string | undefined> = {
  body: undefined,
  caption: 'oc-caption',
  muted: 'oc-text--muted',
  strong: 'oc-text--strong',
};

/**
 * Small text primitive for the recurring non-heading roles — notably the
 * muted-caption pattern that was copy-pasted inline across pages
 * (`color: var(--color-text-muted)`). Use instead of ad-hoc inline styles.
 */
export function Text({ variant = 'body', as, children, className }: TextProps) {
  const Tag = as ?? (variant === 'caption' ? 'p' : 'span');
  return <Tag className={cx(VARIANT_CLASS[variant], className) || undefined}>{children}</Tag>;
}
