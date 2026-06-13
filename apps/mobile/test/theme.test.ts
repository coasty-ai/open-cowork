import { describe, it, expect } from 'vitest';
import {
  colors,
  colorsLight,
  spacing,
  radius,
  space,
  typography,
  tinted,
  formatCents,
} from '../src/theme';
import { themes, tint } from '@open-cowork/tokens';

/**
 * The mobile theme is a thin adapter over @open-cowork/tokens (the same source
 * web's tokens.css is generated from), so palette parity is automatic. These
 * tests lock the ADAPTER contract: the legacy export shape screens depend on,
 * the previously-buggy formatCents, and the RN-only tinted() helper.
 */
describe('mobile theme adapter', () => {
  it('exposes the legacy colors shape derived from the canonical dark palette', () => {
    expect(Object.keys(colors).sort()).toEqual(
      [
        'accent',
        'accentContrast',
        'bg',
        'border',
        'danger',
        'info',
        'success',
        'surface',
        'surfaceRaised',
        'text',
        'textMuted',
        'warning',
      ].sort(),
    );
    expect(colors.bg).toBe(themes.dark.background);
    expect(colors.accent).toBe(themes.dark.primary);
    expect(colors.danger).toBe(themes.dark.destructiveText);
  });

  it('gains a light palette in the identical shape (mobile had none before)', () => {
    expect(Object.keys(colorsLight)).toEqual(Object.keys(colors));
    expect(colorsLight.bg).toBe(themes.light.background);
  });

  it('keeps the legacy spacing + radius keys mobile screens use', () => {
    expect(spacing.xs).toBe(4);
    expect(spacing.sm).toBe(8);
    expect(spacing.md).toBe(12);
    expect(spacing.lg).toBe(16);
    expect(spacing.xl).toBe(24);
    expect(radius.sm).toBe(4);
    expect(radius.md).toBe(8);
    expect(radius.lg).toBe(12);
    expect(radius.full).toBe(999);
    expect(space[1]).toBe(4);
  });

  it('formatCents handles negatives correctly (the old mobile $-0.05 bug)', () => {
    expect(formatCents(20)).toBe('$0.20');
    expect(formatCents(-5)).toBe('-$0.05');
  });

  it('tinted() composes rgba from a role hex using the shared tint constant', () => {
    expect(tinted('#ff7070')).toBe(`rgba(255, 112, 112, ${tint.border})`);
    expect(tinted('#ffffff', 0.08)).toBe('rgba(255, 255, 255, 0.08)');
  });

  it('exposes the shared typography scale + heading hierarchy', () => {
    expect(typography.fontSize.base).toBe(14);
    expect(typography.headings.h1.size).toBe('3xl');
  });
});
