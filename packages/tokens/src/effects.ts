/**
 * Effects — the shared inputs for things CSS expresses one way and React Native
 * another. We never share a CSS string like `color-mix(...)`; we share the
 * plain inputs (tint %, scrim alpha, shadow geometry) and each platform composes
 * its own form. This is also what unifies the audit's "mobile solid fills vs web
 * translucent tints" divergence — both derive from one `tint` constant.
 */

/** Translucency ratios for tinted borders/fills (badge/error/approval surfaces). */
export const tint = {
  /** Tinted border alpha (e.g. badge border = role color @ 40%). */
  border: 0.4,
  /** Tinted fill alpha (e.g. error-state background = danger @ 8%). */
  fill: 0.08,
} as const;

/** Modal/dialog backdrop scrim, per theme. */
export const overlayScrim = {
  dark: { base: '#000000', alpha: 0.66 },
  light: { base: '#0a0a0a', alpha: 0.4 },
} as const;

/** One layer of a box-shadow; web joins layers into a CSS string, RN maps to native props. */
export interface ShadowLayer {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  alpha: number;
}

/** Subtle, additive elevation (borders remain the primary boundary). Per theme. */
export const shadow: {
  dark: Record<'sm' | 'md' | 'lg', ShadowLayer[]>;
  light: Record<'sm' | 'md' | 'lg', ShadowLayer[]>;
} = {
  dark: {
    sm: [{ x: 0, y: 1, blur: 2, spread: 0, color: '#000000', alpha: 0.4 }],
    md: [{ x: 0, y: 4, blur: 12, spread: -2, color: '#000000', alpha: 0.45 }],
    lg: [{ x: 0, y: 16, blur: 40, spread: -8, color: '#000000', alpha: 0.6 }],
  },
  light: {
    sm: [
      { x: 0, y: 1, blur: 2, spread: 0, color: '#0a0a0a', alpha: 0.06 },
      { x: 0, y: 1, blur: 3, spread: 0, color: '#0a0a0a', alpha: 0.1 },
    ],
    md: [{ x: 0, y: 4, blur: 12, spread: -2, color: '#0a0a0a', alpha: 0.1 }],
    lg: [{ x: 0, y: 16, blur: 40, spread: -8, color: '#0a0a0a', alpha: 0.18 }],
  },
};

/** The inset ring on the logo mark — derived from the mark's own color. */
export const logoRing = { source: 'currentColor', alpha: 0.12 } as const;

/** Focus ring geometry (theme-invariant; the ring color is the `ring` role token). */
export const focusRing = { width: 2, offset: 2 } as const;
