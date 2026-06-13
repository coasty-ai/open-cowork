/**
 * Color roles — shadcn-style role pairs. A `*Foreground` value is the text/icon
 * color that sits ON the matching surface. All values are plain hex so the SAME
 * object can drive web CSS custom properties AND the React Native theme.
 *
 * Contrast figures are documented in DESIGN_SYSTEM.md §2 (verified WCAG AA in
 * both themes). `dark` and `light` share an identical key set by construction
 * (both typed `ColorScale`) — the parity guard relies on this.
 */

export interface ColorScale {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  /** Floating surfaces (dialogs, menus) — one step above `card`. */
  popover: string;
  popoverForeground: string;
  /** Raised fill / de-emphasized surface. */
  muted: string;
  mutedForeground: string;
  secondary: string;
  secondaryForeground: string;
  /** Neutral hover/selected wash (shadcn "accent" — NOT the primary accent). */
  accent: string;
  accentForeground: string;
  /** 1px separator. */
  border: string;
  /** Stronger border for form-control affordance. */
  input: string;
  /** Focus ring (= primary). */
  ring: string;
  /** The primary accent — monochrome: near-white on dark, near-black on light. */
  primary: string;
  primaryForeground: string;
  /** Solid-fill danger (buttons, banners). */
  destructive: string;
  destructiveForeground: string;
  /** Danger used as text / border / dot (passes AA as text on background). */
  destructiveText: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  info: string;
  infoForeground: string;
}

/** Hover/active fills, kept per-role so contrast never drops below AA. */
export interface InteractionColors {
  primaryHover: string;
  primaryActive: string;
  secondaryHover: string;
  destructiveHover: string;
}

/** Dark palette — the product's default identity (`:root`). */
export const dark: ColorScale = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  card: '#161616',
  cardForeground: '#fafafa',
  popover: '#1c1c1c',
  popoverForeground: '#fafafa',
  muted: '#1f1f1f',
  mutedForeground: '#a3a3a3',
  secondary: '#272727',
  secondaryForeground: '#fafafa',
  accent: '#272727',
  accentForeground: '#fafafa',
  border: '#2e2e2e',
  input: '#404040',
  ring: '#fafafa',
  primary: '#fafafa',
  primaryForeground: '#0a0a0a',
  destructive: '#d83a3f',
  destructiveForeground: '#ffffff',
  destructiveText: '#ff7070',
  success: '#4ade80',
  successForeground: '#06140c',
  warning: '#f5b83d',
  warningForeground: '#1a1300',
  // "info" (e.g. Running) has no inherent hue — kept neutral so the palette has
  // ZERO blue. Running stays legible via its label + the animated pulse dot.
  info: '#fafafa',
  infoForeground: '#0a0a0a',
};

/** Light palette — a first-class peer (`[data-theme='light']`). */
export const light: ColorScale = {
  background: '#fafafa',
  foreground: '#0a0a0a',
  card: '#ffffff',
  cardForeground: '#0a0a0a',
  popover: '#ffffff',
  popoverForeground: '#0a0a0a',
  muted: '#f4f4f4',
  mutedForeground: '#555555',
  secondary: '#f4f4f4',
  secondaryForeground: '#0a0a0a',
  accent: '#f4f4f4',
  accentForeground: '#0a0a0a',
  border: '#e4e4e4',
  input: '#cacaca',
  ring: '#0a0a0a',
  primary: '#0a0a0a',
  primaryForeground: '#fafafa',
  destructive: '#c5303a',
  destructiveForeground: '#ffffff',
  destructiveText: '#c5303a',
  success: '#0f7a4f',
  successForeground: '#ffffff',
  warning: '#8a5a00',
  warningForeground: '#ffffff',
  info: '#0a0a0a',
  infoForeground: '#ffffff',
};

export const interactionDark: InteractionColors = {
  primaryHover: '#e3e3e3',
  primaryActive: '#cfcfcf',
  secondaryHover: '#2e2e2e',
  destructiveHover: '#e5484d',
};

export const interactionLight: InteractionColors = {
  primaryHover: '#2b2b2b',
  primaryActive: '#000000',
  secondaryHover: '#e8e8e8',
  destructiveHover: '#b32a33',
};

/** Disabled controls dim by opacity (never recolored to a low-contrast gray). */
export const disabledOpacity = 0.5;

/** Both themes, keyed by `data-theme` value. */
export const themes: { dark: ColorScale; light: ColorScale } = { dark, light };
export const interaction: { dark: InteractionColors; light: InteractionColors } = {
  dark: interactionDark,
  light: interactionLight,
};
