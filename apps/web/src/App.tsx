import { Component, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  ErrorState,
  Icon,
  Logo,
  OfflineBanner,
  Sidebar,
  SidebarSection,
  Text,
} from '@open-cowork/ui';
import type { IconName } from '@open-cowork/ui';
import { useAuth } from './store';
import { CoastyKeyProvider } from './coastyKey';
import { ThemeSwitch } from './components/ThemeSwitch';
import { useGlobalFeed } from './useGlobalFeed';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowDetailPage } from './pages/WorkflowDetailPage';
import { WorkflowRunDetailPage } from './pages/WorkflowRunDetailPage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div role="main" className="app-main">
          <div className="app-main__inner">
            <ErrorState
              message={`Something went wrong: ${this.state.error.message}`}
              onRetry={() => this.setState({ error: null })}
            />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface NavItem {
  to: string;
  end?: boolean;
  icon: IconName;
  label: string;
}

const NAV_SECTIONS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  {
    label: 'Workspace',
    items: [
      { to: '/', end: true, icon: 'delegate', label: 'Delegate' },
      { to: '/runs', icon: 'runs', label: 'Runs' },
      { to: '/workflows', icon: 'workflows', label: 'Workflows' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/machines', icon: 'machines', label: 'Machines' },
      { to: '/settings', icon: 'settings', label: 'Settings' },
    ],
  },
];

const SIDEBAR_KEY = 'oc-sidebar-collapsed';

function Shell({ children }: { children: ReactNode }) {
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);
  const { offline, banner } = useGlobalFeed();
  const [collapsed, setCollapsed] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_KEY) === '1',
  );
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable — collapse still works for this session */
      }
      return next;
    });

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        brand={
          <NavLink to="/" end className="oc-sidebar__brand-link" aria-label="Open Co-Work home">
            <Logo size={24} withWordmark={!collapsed} />
          </NavLink>
        }
        footer={
          collapsed ? (
            <>
              <ThemeSwitch collapsed />
              <button
                type="button"
                className="oc-sidebar__icon-btn"
                onClick={logout}
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="logout" size={18} />
              </button>
            </>
          ) : (
            <>
              <ThemeSwitch />
              <div className="oc-sidebar__account">
                <Text variant="caption" className="oc-sidebar__email">
                  {user?.email}
                </Text>
                <button
                  type="button"
                  className="oc-sidebar__icon-btn"
                  onClick={logout}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <Icon name="logout" size={18} />
                </button>
              </div>
            </>
          )
        }
      >
        {NAV_SECTIONS.map((section) => (
          <SidebarSection key={section.label} label={section.label}>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className="oc-sidebar__item"
                aria-label={item.label}
                title={collapsed ? item.label : undefined}
              >
                <Icon name={item.icon} className="oc-sidebar__item-icon" />
                <span className="oc-sidebar__label">{item.label}</span>
              </NavLink>
            ))}
          </SidebarSection>
        ))}
      </Sidebar>
      <main className="app-main">
        <div className="app-main__inner">
          <OfflineBanner offline={offline} />
          {banner}
          {children}
        </div>
      </main>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <ErrorBoundary>
      <CoastyKeyProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/runs"
            element={
              <RequireAuth>
                <RunsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/runs/:id"
            element={
              <RequireAuth>
                <RunDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows"
            element={
              <RequireAuth>
                <WorkflowsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/runs/:id"
            element={
              <RequireAuth>
                <WorkflowRunDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/:id"
            element={
              <RequireAuth>
                <WorkflowDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/machines"
            element={
              <RequireAuth>
                <MachinesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </CoastyKeyProvider>
    </ErrorBoundary>
  );
}
