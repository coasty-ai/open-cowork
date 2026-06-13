/**
 * @open-cowork/tokens — the single, platform-neutral source of truth for the
 * design system. Plain JS values only (hex strings + numbers), zero runtime
 * deps, isomorphic. Consumed by:
 *   - packages/ui  → generates `tokens.css` (CSS custom properties) + parity test
 *   - apps/mobile  → `theme.ts` imports these directly (RN can't use CSS)
 *
 * Anything CSS-only (color-mix, calc, rem, :focus-visible) is composed per
 * platform from the plain inputs here — never shared as a CSS string.
 */
export * from './colors';
export * from './spacing';
export * from './radii';
export * from './typography';
export * from './effects';
export { formatCents, RUN_STATUS_META } from './format';
export type { RunStatus, StatusTone, RunStatusMeta } from './format';
