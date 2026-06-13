import type { ReactNode } from 'react';
import { cx } from '../cx';
import { Icon } from './Icon';

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  /** Collapsed = icon-only rail. Controlled by the consumer (persist it). */
  collapsed: boolean;
  /** Toggle handler for the collapse button. */
  onToggleCollapsed: () => void;
  /** Brand slot (e.g. `<Logo withWordmark={!collapsed} />`). */
  brand: ReactNode;
  /** Nav items — compose `oc-sidebar__item` links (see SidebarItem helpers in CSS). */
  children: ReactNode;
  /** Optional footer slot (account, sign-out). */
  footer?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

/**
 * A sleek, minimal, collapsible navigation rail for web/desktop. Routing-
 * agnostic: the shell owns the chrome (brand, collapse toggle, footer) and the
 * collapsed/expanded transition; the app fills the nav with its own links
 * (`className="oc-sidebar__item"` + an {@link Icon} + `.oc-sidebar__label`).
 *
 * Mobile (React Native) deliberately uses a bottom tab bar instead — a side
 * rail isn't a touch-nav idiom.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  brand,
  children,
  footer,
  className,
  ariaLabel = 'Primary',
}: SidebarProps) {
  return (
    <nav
      className={cx('oc-sidebar', className)}
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={ariaLabel}
    >
      <div className="oc-sidebar__header">
        <span className="oc-sidebar__brand">{brand}</span>
        <button
          type="button"
          className="oc-sidebar__toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon name="panelLeft" size={18} />
        </button>
      </div>
      <div className="oc-sidebar__nav">{children}</div>
      {footer ? <div className="oc-sidebar__footer">{footer}</div> : null}
    </nav>
  );
}
