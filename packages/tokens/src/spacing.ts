/**
 * Spacing — a single 4px scale (the audit's cleanest area, kept as-is).
 *
 * `space` is the canonical truth: index 1..8 map to the web `--space-1..8`
 * custom properties and to React Native numeric padding/margins/gaps. Index 0
 * is `0` so `space[n]` reads naturally. `spacingNamed` is a friendly RN alias
 * layer (mobile historically used xs/sm/md/lg/xl) over the same grid, now with
 * the previously-missing larger rungs available.
 */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40] as const;

export const spacingNamed = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xl2: 32,
  xl3: 40,
} as const;
