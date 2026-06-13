import type { ReactNode } from 'react';
import { cx } from '../cx';

/** Heading level — drives both the rendered tag (`h1`–`h4`) and the type preset. */
export type HeadingLevel = 1 | 2 | 3 | 4;

/** Props for {@link Heading}. */
export interface HeadingProps {
  /** Visual + semantic level. Default 2. */
  level?: HeadingLevel;
  children: ReactNode;
  className?: string;
  id?: string;
}

/**
 * The one heading primitive. Renders the matching `h1`–`h4` tag with the shared
 * `oc-h{level}` type preset, so every heading in the app draws from a single
 * hierarchy (no per-page font-size literals). Sizes decrease with level:
 * h1 26 · h2 21 · h3 18 · h4 16.
 */
export function Heading({ level = 2, children, className, id }: HeadingProps) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return (
    <Tag id={id} className={cx(`oc-h${level}`, className)}>
      {children}
    </Tag>
  );
}
