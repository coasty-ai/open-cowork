/**
 * Single source of truth for "is the Coasty API key set?". One provider fetches
 * the (public, secret-free) status once and shares it, so every gated feature
 * reacts consistently instead of each page checking on its own. It re-fetches
 * when the session token changes (e.g. right after login attaches a key) and
 * exposes `refresh()` for Settings to call after set/clear.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getClient, useAuth } from './store';
import type { CoastyKeyStatus } from './api/client';

interface CoastyKeyValue {
  /** Latest status, or null before the first fetch resolves / on failure. */
  status: CoastyKeyStatus | null;
  /** A real key is active (env or runtime). The gate shows when this is false. */
  configured: boolean;
  /** True once the first fetch has settled (success or failure). */
  ready: boolean;
  /** Re-fetch the status (call after set/clear so gated features update). */
  refresh: () => Promise<void>;
}

const CoastyKeyContext = createContext<CoastyKeyValue | null>(null);

export function CoastyKeyProvider({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  const [status, setStatus] = useState<CoastyKeyStatus | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getClient().coastyKeyStatus());
    } catch {
      setStatus(null);
    } finally {
      setReady(true);
    }
  }, []);

  // Fetch on mount and whenever the session changes (login may have just
  // attached a key; logout shouldn't strand a stale "configured").
  useEffect(() => {
    void refresh();
  }, [refresh, token]);

  return (
    <CoastyKeyContext.Provider
      value={{ status, configured: status?.configured ?? false, ready, refresh }}
    >
      {children}
    </CoastyKeyContext.Provider>
  );
}

export function useCoastyKey(): CoastyKeyValue {
  const ctx = useContext(CoastyKeyContext);
  if (!ctx) throw new Error('useCoastyKey must be used within a CoastyKeyProvider');
  return ctx;
}
