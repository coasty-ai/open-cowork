/**
 * Generate the web `tokens.css` from the platform-neutral token source.
 *
 * This is the ONLY place CSS custom properties are produced — `tokens.css` is a
 * generated artifact (prettier-ignored), and a parity test re-runs this builder
 * and byte-compares it to the committed file, so the two cannot drift. CSS-only
 * forms (calc, color-mix, the `var()` aliases) are composed here from the same
 * plain values React Native consumes directly.
 */
import { dark, light, interactionDark, interactionLight, disabledOpacity } from './colors';
import type { ColorScale, InteractionColors } from './colors';
import { space } from './spacing';
import { radius, radiusBase } from './radii';
import { fontSize, lineHeight, fontWeight, fontFamily } from './typography';
import { shadow, logoRing, overlayScrim, focusRing } from './effects';
import type { ShadowLayer } from './effects';

const camelToKebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const hexToTriplet = (hex: string): string => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
};

const rem = (px: number): string => `${px / 16}rem`;

const shadowToCss = (layers: ShadowLayer[]): string =>
  layers
    .map(
      (l) =>
        `${l.x}px ${l.y}px ${l.blur}px ${l.spread}px rgb(${hexToTriplet(l.color)} / ${l.alpha})`,
    )
    .join(', ');

/** Legacy `--color-*` names kept as thin aliases so existing CSS keeps working. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--color-bg', '--background'],
  ['--color-surface', '--card'],
  ['--color-surface-raised', '--muted'],
  ['--color-border', '--border'],
  ['--color-text', '--foreground'],
  ['--color-text-muted', '--muted-foreground'],
  ['--color-accent', '--primary'],
  ['--color-accent-contrast', '--primary-foreground'],
  ['--color-success', '--success'],
  ['--color-warning', '--warning'],
  ['--color-danger', '--destructive-text'],
  ['--color-info', '--info'],
  ['--focus-ring-color', '--ring'],
];

const roleVars = (scale: ColorScale): string =>
  Object.entries(scale)
    .map(([k, v]) => `  --${camelToKebab(k)}: ${v};`)
    .join('\n');

const interactionVars = (i: InteractionColors): string =>
  Object.entries(i)
    .map(([k, v]) => `  --${camelToKebab(k)}: ${v};`)
    .join('\n');

/** Build the full contents of `packages/ui/src/tokens.css`. Deterministic. */
export function buildTokensCss(): string {
  const spacing = space
    .slice(1)
    .map((px, i) => `  --space-${i + 1}: ${rem(px)};`)
    .join('\n');

  const sizes = (Object.entries(fontSize) as [string, number][])
    .map(([k, px]) => `  --font-size-${k}: ${rem(px)};`)
    .join('\n');
  const lineHeights = Object.entries(lineHeight)
    .map(([k, v]) => `  --lh-${k}: ${v};`)
    .join('\n');
  const weights = Object.entries(fontWeight)
    .map(([k, v]) => `  --font-weight-${k}: ${v};`)
    .join('\n');

  const aliases = ALIASES.map(([alias, role]) => `  ${alias}: var(${role});`).join('\n');

  const ringCss = `inset 0 0 0 1px color-mix(in srgb, ${logoRing.source} ${logoRing.alpha * 100}%, transparent)`;
  const scrim = (t: 'dark' | 'light'): string =>
    `rgb(${hexToTriplet(overlayScrim[t].base)} / ${overlayScrim[t].alpha})`;

  const root = `:root {
  color-scheme: dark;

  /* ---- Color roles (dark) ---- */
${roleVars(dark)}

  /* ---- Interaction states ---- */
${interactionVars(interactionDark)}
  --disabled-opacity: ${disabledOpacity};

  /* ---- Spacing (4px scale) ---- */
${spacing}

  /* ---- Radii (single base, derived steps) ---- */
  --radius: ${radiusBase}px;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 4px);
  --radius-full: ${radius.full}px;

  /* ---- Typography ---- */
${sizes}
${lineHeights}
${weights}
  --font-sans: ${fontFamily.sans};
  --font-mono: ${fontFamily.mono};

  /* ---- Focus ring ---- */
  --focus-ring-width: ${focusRing.width}px;
  --focus-ring-offset: ${focusRing.offset}px;

  /* ---- Elevation (subtle; borders remain primary) ---- */
  --shadow-sm: ${shadowToCss(shadow.dark.sm)};
  --shadow-md: ${shadowToCss(shadow.dark.md)};
  --shadow-lg: ${shadowToCss(shadow.dark.lg)};
  --shadow-ring: ${ringCss};
  --overlay-scrim: ${scrim('dark')};

  /* ---- Legacy aliases (generated; prefer the role tokens above in new code) ---- */
${aliases}
}`;

  const lightBlock = `[data-theme='light'] {
  color-scheme: light;

  /* ---- Color roles (light) ---- */
${roleVars(light)}

  /* ---- Interaction states ---- */
${interactionVars(interactionLight)}

  /* ---- Elevation (light) ---- */
  --shadow-sm: ${shadowToCss(shadow.light.sm)};
  --shadow-md: ${shadowToCss(shadow.light.md)};
  --shadow-lg: ${shadowToCss(shadow.light.lg)};
  --overlay-scrim: ${scrim('light')};
}`;

  const header = `/**
 * open-cowork design tokens — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: packages/tokens/src/*.ts
 * Regenerate:      pnpm --filter @open-cowork/tokens gen:css
 * A parity test (packages/ui) byte-compares this file to the generator output.
 *
 * Dark is the default (:root); light is a first-class peer ([data-theme='light']).
 * Legacy --color-* names are kept as aliases so existing oc-* rules keep working.
 */`;

  return `${header}\n\n${root}\n\n${lightBlock}\n`;
}
