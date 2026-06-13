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
  /** Neutral hover/selected wash (shadcn "accent" — NOT the brand blue). */
  accent: string;
  accentForeground: string;
  /** 1px separator. */
  border: string;
  /** Stronger border for form-control affordance. */
  input: string;
  /** Focus ring (= primary). */
  ring: string;
  /** The restrained brand accent. */
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
  background: '#0b0e15',
  foreground: '#e8ebf2',
  card: '#151a27',
  cardForeground: '#e8ebf2',
  popover: '#1a2030',
  popoverForeground: '#e8ebf2',
  muted: '#1d2435',
  mutedForeground: '#9aa3b8',
  secondary: '#222a3d',
  secondaryForeground: '#e8ebf2',
  accent: '#222a3d',
  accentForeground: '#e8ebf2',
  border: '#2b3349',
  input: '#3a4358',
  ring: '#6c8cff',
  primary: '#6c8cff',
  primaryForeground: '#0b0e15',
  destructive: '#d83a3f',
  destructiveForeground: '#ffffff',
  destructiveText: '#ff7070',
  success: '#4ade80',
  successForeground: '#06140c',
  warning: '#f5b83d',
  warningForeground: '#1a1300',
  info: '#56c7e0',
  infoForeground: '#04161b',
};

/** Light palette — a first-class peer (`[data-theme='light']`). */
export const light: ColorScale = {
  background: '#f7f8fa',
  foreground: '#1a1f2e',
  card: '#ffffff',
  cardForeground: '#1a1f2e',
  popover: '#ffffff',
  popoverForeground: '#1a1f2e',
  muted: '#eef0f5',
  mutedForeground: '#586074',
  secondary: '#eef0f5',
  secondaryForeground: '#1a1f2e',
  accent: '#eef0f5',
  accentForeground: '#1a1f2e',
  border: '#d6dae3',
  input: '#c2c8d4',
  ring: '#2f5fe0',
  primary: '#2f5fe0',
  primaryForeground: '#ffffff',
  destructive: '#c5303a',
  destructiveForeground: '#ffffff',
  destructiveText: '#c5303a',
  success: '#0f7a4f',
  successForeground: '#ffffff',
  warning: '#8a5a00',
  warningForeground: '#ffffff',
  info: '#0c6f8a',
  infoForeground: '#ffffff',
};

export const interactionDark: InteractionColors = {
  primaryHover: '#7d9aff',
  primaryActive: '#5b7df0',
  secondaryHover: '#2a3349',
  destructiveHover: '#e5484d',
};

export const interactionLight: InteractionColors = {
  primaryHover: '#2a55cc',
  primaryActive: '#244aad',
  secondaryHover: '#e4e7ee',
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
