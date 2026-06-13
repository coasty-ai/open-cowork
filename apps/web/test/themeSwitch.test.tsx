/**
 * ThemeSwitch (sidebar footer): expanded icon-segmented control + collapsed
 * cycle button. Covers default, persistence, OS-following `system`, an invalid
 * stored value, and the collapsed cycle order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeSwitch } from '../src/components/ThemeSwitch';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  localStorage.removeItem('oc-theme');
  vi.unstubAllGlobals();
});

describe('ThemeSwitch (expanded)', () => {
  it('defaults to dark and applies + persists a chosen theme', async () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('oc-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('System follows the OS preference (light)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('light'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(localStorage.getItem('oc-theme')).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reads an invalid stored preference as dark', () => {
    localStorage.setItem('oc-theme', 'banana');
    render(<ThemeSwitch />);
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('ThemeSwitch (collapsed)', () => {
  it('renders a single cycle button that walks system -> light -> dark', async () => {
    localStorage.setItem('oc-theme', 'system');
    render(<ThemeSwitch collapsed />);
    const btn = screen.getByRole('button');

    await userEvent.click(btn); // system -> light
    expect(localStorage.getItem('oc-theme')).toBe('light');
    await userEvent.click(btn); // light -> dark
    expect(localStorage.getItem('oc-theme')).toBe('dark');
    await userEvent.click(btn); // dark -> system (wraps)
    expect(localStorage.getItem('oc-theme')).toBe('system');
  });
});
