/**
 * Border radii — one tunable base; the named steps derive from it. Web emits
 * `--radius-*` via `calc()` off `--radius`; React Native consumes the resolved
 * integers (no `calc`). Both stay byte-identical to today's 4/8/12/999.
 */
export const radiusBase = 8;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 999,
} as const;
