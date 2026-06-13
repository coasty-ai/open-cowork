/**
 * Typography — one ladder, one hierarchy. The audit's #1 gap was the total
 * absence of a type scale; this is the canonical source for both platforms.
 *
 * Sizes are px numbers (web converts to `rem`, RN uses them directly). Heading
 * presets are composite so "one hierarchy everywhere" is enforceable — the same
 * shape mirrors 1:1 into the RN `typography` object. Base body stays 14px to
 * match today's product (no global type-size bump).
 */

/** Size ladder in px. `2xs` (11) < `xs` (12); both exist to absorb today's tiny labels without enlarging them. */
export const fontSize = {
  '2xs': 11,
  xs: 12,
  sm: 13,
  base: 14,
  md: 15,
  lg: 16,
  xl: 18,
  '2xl': 21,
  '3xl': 26,
} as const;

export const lineHeight = {
  tight: 1.25,
  snug: 1.4,
  normal: 1.5,
} as const;

export const fontWeight = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const fontFamily = {
  sans: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
} as const;

export type FontSizeKey = keyof typeof fontSize;
export type LineHeightKey = keyof typeof lineHeight;
export type FontWeightKey = keyof typeof fontWeight;

/** A named heading preset. `letterSpacing` is in `em` (web `em`; RN multiplies by size). */
export interface HeadingPreset {
  size: FontSizeKey;
  lineHeight: LineHeightKey;
  weight: FontWeightKey;
  letterSpacing: number;
}

/** The hierarchy contract — identical keys mirror into the RN theme. */
export const headings = {
  h1: { size: '3xl', lineHeight: 'tight', weight: 'bold', letterSpacing: -0.02 },
  h2: { size: '2xl', lineHeight: 'tight', weight: 'bold', letterSpacing: -0.015 },
  h3: { size: 'xl', lineHeight: 'snug', weight: 'semibold', letterSpacing: -0.01 },
  h4: { size: 'lg', lineHeight: 'snug', weight: 'semibold', letterSpacing: -0.005 },
  body: { size: 'base', lineHeight: 'normal', weight: 'normal', letterSpacing: 0 },
  bodyStrong: { size: 'base', lineHeight: 'normal', weight: 'semibold', letterSpacing: 0 },
  caption: { size: 'sm', lineHeight: 'normal', weight: 'normal', letterSpacing: 0 },
  micro: { size: 'xs', lineHeight: 'snug', weight: 'semibold', letterSpacing: 0 },
} satisfies Record<string, HeadingPreset>;

export type HeadingLevel = keyof typeof headings;
