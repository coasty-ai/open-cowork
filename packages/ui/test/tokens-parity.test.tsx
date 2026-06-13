import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTokensCss } from '@open-cowork/tokens/generate';
import { dark, light } from '@open-cowork/tokens';

/**
 * Drift guard for the single token source of truth.
 *
 * packages/ui/src/tokens.css is GENERATED from @open-cowork/tokens. This test
 * re-runs the generator and byte-compares it to the committed file, so:
 *   - a token value changed in the source but `gen:css` not re-run → fails
 *   - tokens.css hand-edited → fails
 * (The mobile side consumes the same source directly via theme.ts, so it can't
 * drift by construction — no generated file there to guard.)
 */
const committedCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tokens.css'),
  'utf8',
);

const norm = (s: string): string => s.replace(/\r\n/g, '\n');
const camelToKebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Custom-property names declared inside a given selector block. */
function declaredVars(css: string, selector: string): Set<string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return new Set();
  const block = css.slice(start, css.indexOf('\n}', start));
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string));
}

describe('tokens.css parity with @open-cowork/tokens', () => {
  it('the committed CSS is exactly what the generator produces (no drift, no hand-edits)', () => {
    expect(norm(committedCss)).toBe(norm(buildTokensCss()));
  });

  it('declares every role token in both the dark (:root) and light blocks', () => {
    const rootVars = declaredVars(committedCss, ':root');
    const lightVars = declaredVars(committedCss, "[data-theme='light']");
    for (const key of Object.keys(dark)) {
      expect(rootVars.has(`--${camelToKebab(key)}`), `dark --${camelToKebab(key)}`).toBe(true);
    }
    for (const key of Object.keys(light)) {
      expect(lightVars.has(`--${camelToKebab(key)}`), `light --${camelToKebab(key)}`).toBe(true);
    }
  });

  it('dark and light define an identical role-token key set (catches a missing theme)', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('preserves the legacy aliases so existing oc-* rules keep resolving', () => {
    for (const alias of [
      '--color-bg: var(--background)',
      '--color-surface: var(--card)',
      '--color-text: var(--foreground)',
      '--color-accent: var(--primary)',
      '--color-danger: var(--destructive-text)',
      '--focus-ring-color: var(--ring)',
    ]) {
      expect(committedCss).toContain(alias);
    }
  });

  it('ships the restrained accent + the new typography scale', () => {
    expect(committedCss).toContain(`--primary: ${dark.primary};`); // #6c8cff
    expect(committedCss).toContain('--font-size-base: 0.875rem;'); // 14px body
    expect(committedCss).toContain('--font-size-2xl: 1.3125rem;'); // 21px h2
  });
});
