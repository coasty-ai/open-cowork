import { useState } from 'react';
import { Icon, type IconName } from '@open-cowork/ui';
import { getThemePref, setThemePref, type ThemePref } from '../theme';

const OPTIONS: ReadonlyArray<{ value: ThemePref; icon: IconName; label: string }> = [
  { value: 'system', icon: 'monitor', label: 'System' },
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
];

/**
 * Theme control for the sidebar footer. Expanded: a compact icon-segmented
 * group (System / Light / Dark). Collapsed rail: a single button cycling
 * through the three, showing the current mode's icon. Persists via theme.ts.
 */
export function ThemeSwitch({ collapsed = false }: { collapsed?: boolean }) {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());
  const choose = (next: ThemePref) => {
    setPref(next);
    setThemePref(next);
  };

  if (collapsed) {
    const idx = OPTIONS.findIndex((o) => o.value === pref);
    const current = OPTIONS[idx] ?? OPTIONS[0]!;
    const next = OPTIONS[(idx + 1) % OPTIONS.length]!;
    return (
      <button
        type="button"
        className="oc-sidebar__icon-btn"
        onClick={() => choose(next.value)}
        aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
        title={`Theme: ${current.label}`}
      >
        <Icon name={current.icon} size={18} />
      </button>
    );
  }

  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="theme-switch__btn"
          data-active={pref === o.value}
          aria-pressed={pref === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => choose(o.value)}
        >
          <Icon name={o.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
