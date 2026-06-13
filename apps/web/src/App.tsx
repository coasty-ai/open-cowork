import { Component, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Button, ErrorState, Logo, OfflineBanner } from '@open-cowork/ui';
import { useAuth } from './store';
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
        <div role="main" style={{ padding: 24 }}>
          <ErrorState
            message={`Something went wrong: ${this.state.error.message}`}
            onRetry={() => this.setState({ error: null })}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function Shell({ children }: { children: ReactNode }) {
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);
  const { offline, banner } = useGlobalFeed();
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Primary">
        <NavLink to="/" end className="app-nav__brand" aria-label="open-cowork home">
          <Logo size={24} />
        </NavLink>
        <NavLink to="/" end>
          Delegate
        </NavLink>
        <NavLink to="/runs">Runs</NavLink>
        <NavLink to="/workflows">Workflows</NavLink>
        <NavLink to="/machines">Machines</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="app-nav__footer">
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
            {user?.email}
          </span>
          <Button variant="ghost" size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </nav>
      <main className="app-main">
        <OfflineBanner offline={offline} />
        {banner}
        {children}
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
    </ErrorBoundary>
  );
}
