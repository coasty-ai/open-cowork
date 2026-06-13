/**
 * Mobile theme — a thin ADAPTER over @open-cowork/tokens, the single source of
 * truth shared with web. React Native can't use CSS, but it CAN import the plain
 * token values directly, so mobile now stays in lockstep with `tokens.css` by
 * construction (no hand-copied palette, no drift — they read the same module).
 *
 * Legacy named exports (`colors`, `spacing`, `radius`, `formatCents`) are kept
 * with their existing shapes so current StyleSheet code is untouched; mobile
 * additionally gains a light palette, the typography scale, the `tinted()`
 * helper (RN's stand-in for CSS `color-mix`), and native shadow presets.
 */
import {
  themes,
  interaction,
  spacingNamed,
  space as spaceScale,
  radius as radiusTokens,
  fontSize,
  lineHeight,
  fontWeight,
  fontFamily,
  headings,
  tint,
  shadow as shadowGeometry,
  formatCents,
} from '@open-cowork/tokens';
import type { ColorScale, ShadowLayer } from '@open-cowork/tokens';

export { formatCents };

/** Map shadcn role tokens onto the legacy `colors` keys mobile screens import. */
function legacyColors(c: ColorScale) {
  return {
    bg: c.background,
    surface: c.card,
    surfaceRaised: c.muted,
    border: c.border,
    text: c.foreground,
    textMuted: c.mutedForeground,
    accent: c.primary,
    accentContrast: c.primaryForeground,
    success: c.success,
    warning: c.warning,
    danger: c.destructiveText,
    info: c.info,
  } as const;
}

/** Full role palettes — mobile gains a first-class light theme here. */
export const palettes = { dark: themes.dark, light: themes.light } as const;

/** Dark is the product identity and the current default. */
export const colors = legacyColors(themes.dark);
/** Light palette in the same legacy shape (wired to screens in Phase 3). */
export const colorsLight = legacyColors(themes.light);

/** Hover/active fills (parity with web's interaction tokens). */
export const interactionColors = interaction;

export const spacing = spacingNamed;
/** Numeric 4px scale (index 1..8); new code can use this directly. */
export const space = spaceScale;
export const radius = radiusTokens;

/** The shared type scale + heading-preset hierarchy (mirrors web 1:1). */
export const typography = { fontSize, lineHeight, fontWeight, fontFamily, headings } as const;

/**
 * RN stand-in for CSS `color-mix(... transparent)`: a translucent role color.
 * Uses the SAME `tint` constants as web, so a badge border / error tint reads
 * identically on both platforms (fixes the audit's solid-vs-translucent split).
 */
export function tinted(hex: string, alpha: number = tint.border): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Collapse a (possibly multi-layer) shadow to RN's single-shadow + elevation. */
function rnShadow(layers: ShadowLayer[], elevation: number) {
  const l = layers.reduce((a, b) => (b.blur >= a.blur ? b : a));
  return {
    shadowColor: l.color,
    shadowOffset: { width: l.x, height: l.y },
    shadowOpacity: l.alpha,
    shadowRadius: l.blur,
    elevation,
  } as const;
}

/** Native elevation presets derived from the shared shadow geometry (dark). */
export const shadow = {
  sm: rnShadow(shadowGeometry.dark.sm, 1),
  md: rnShadow(shadowGeometry.dark.md, 4),
  lg: rnShadow(shadowGeometry.dark.lg, 12),
} as const;
