import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

/** Props for {@link Card}. */
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Optional heading rendered at the top of the card. */
  title?: ReactNode;
  children?: ReactNode;
}

/** Raised surface container with an optional title heading. */
export function Card({ title, className, children, ...rest }: CardProps) {
  return (
    <section className={cx('oc-card', className)} {...rest}>
      {title !== undefined && title !== null ? <h3 className="oc-card__title">{title}</h3> : null}
      {children}
    </section>
  );
}
