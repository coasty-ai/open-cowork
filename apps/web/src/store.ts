/**
 * Session store (zustand): the auth token + user, persisted to localStorage.
 * The token is a short-lived open-cowork session token — never the Coasty key.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BackendClient, type SessionUser } from './api/client';

export interface AuthState {
  token: string | null;
  user: SessionUser | null;
  setAuth: (token: string, user: SessionUser) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    { name: 'cowork-session' },
  ),
);

let client: BackendClient | null = null;

/** Singleton backend client bound to the session store. */
export function getClient(): BackendClient {
  if (!client) {
    client = new BackendClient({ getToken: () => useAuth.getState().token });
  }
  return client;
}

/** Test seam. */
export function setClientForTests(c: BackendClient | null): void {
  client = c;
}
