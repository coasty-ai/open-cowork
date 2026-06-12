/**
 * Auth context: React state on top of the module-level token store in api.ts.
 * LoginScreen performs the actual login (api.login + setToken) and hands the
 * user up; signOut clears both layers.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { setToken, type SessionUser } from './api';

export interface AuthContextValue {
  user: SessionUser | null;
  completeLogin: (user: SessionUser) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      completeLogin: (u) => setUser(u),
      signOut: () => {
        setToken(null);
        setUser(null);
      },
    }),
    [user],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
