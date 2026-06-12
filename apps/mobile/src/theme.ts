/**
 * Dark-first palette mirroring packages/ui tokens.css (the mobile app cannot
 * import @open-cowork/ui because that library renders DOM elements).
 */
export const colors = {
  bg: '#0b0e14',
  surface: '#131826',
  surfaceRaised: '#1c2333',
  border: '#2a3247',
  text: '#e7eaf2',
  textMuted: '#98a2b8',
  accent: '#5b8cff',
  accentContrast: '#0b0e14',
  success: '#3ecf8e',
  warning: '#f5b83d',
  danger: '#ff6b6b',
  info: '#58c4dc',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 999,
} as const;

/** Render integer cents as a dollar string, e.g. 42 -> '$0.42'. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
