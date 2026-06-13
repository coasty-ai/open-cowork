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

/** Props for {@link SidebarSection}. */
export interface SidebarSectionProps {
  /** Small uppercase group heading. Hidden automatically in the collapsed rail
   * (where a thin divider separates groups instead) and on the phone top bar. */
  label?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A labelled group of nav items inside a {@link Sidebar}. Groups give the rail
 * clear sections; the label collapses to a divider in icon-only mode and the
 * whole group flattens into the row on the phone top bar.
 */
export function SidebarSection({ label, children, className }: SidebarSectionProps) {
  return (
    <div className={cx('oc-sidebar__section', className)}>
      {label ? <p className="oc-sidebar__section-label">{label}</p> : null}
      <div className="oc-sidebar__section-items">{children}</div>
    </div>
  );
}
