/**
 * Theme preference: persisted to localStorage and applied as `data-theme` on
 * <html>. The product is dark-first, so the default (no stored choice) is dark;
 * users can opt into Light or System (follows the OS). The initial paint is set
 * by a tiny inline script in index.html to avoid a flash — this module owns the
 * persisted choice and keeps `System` live as the OS preference changes.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'oc-theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'system' || v === 'light' || v === 'dark') return v;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

function systemTheme(): 'light' | 'dark' {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? systemTheme() : pref;
}

function apply(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable — still apply for this session */
  }
  apply(pref);
}

/**
 * Apply the stored preference and keep `System` tracking the OS while the app
 * runs. Call once at startup (after the inline script set the first paint).
 */
export function initTheme(): void {
  apply(getThemePref());
  if (typeof matchMedia === 'undefined') return;
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getThemePref() === 'system') apply('system');
  });
}
