import { useId } from 'react';
import { cx } from '../cx';

/** Props for {@link Logo}. */
export interface LogoProps {
  /** Mark size in px; the wordmark scales to match. Default 28. */
  size?: number;
  /** Render the "Open Co-Work" wordmark next to the mark. Default true. */
  withWordmark?: boolean;
  className?: string;
  /** Accessible label for the mark. Default "Open Co-Work". */
  title?: string;
}

/**
 * The Open Co-Work brand mark + wordmark — the single source for the brand mark.
 *
 * The mark is the "horizon" gradient circle as a theme-aware SVG: it fades from
 * transparent to `currentColor`, so on a dark surface it renders as the white
 * mark and on a light surface as the black one — no asset swap, always crisp.
 * The wordmark is a sleek two-tone lockup: a muted "Open" + a bold "Co-Work".
 * Place it on any element that sets a text color (the nav, login, headers).
 */
export function Logo({
  size = 28,
  withWordmark = true,
  className,
  title = 'Open Co-Work',
}: LogoProps) {
  const gradId = useId();
  return (
    <span className={cx('oc-logo', className)} style={{ fontSize: size * 0.62 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        role="img"
        aria-label={title}
        focusable="false"
        className="oc-logo__mark"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
            <stop offset="25%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="45%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="60%" stopColor="currentColor" stopOpacity="0.4" />
            <stop offset="80%" stopColor="currentColor" stopOpacity="0.75" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="100" fill={`url(#${gradId})`} />
      </svg>
      {withWordmark ? (
        <span className="oc-logo__word" aria-hidden="true">
          <span className="oc-logo__word-soft">Open</span> Co-Work
        </span>
      ) : null}
    </span>
  );
}
