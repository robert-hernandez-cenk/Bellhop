import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { apiGet } from '../api/client';
import type { WhoAmI } from '../api/types';
import { createWhoAmIStore, type WhoAmIState } from './whoami-store';

interface WhoAmIContextValue extends WhoAmIState {
  refresh: () => Promise<void>;
}

const WhoAmIContext = createContext<WhoAmIContextValue | null>(null);

export function WhoAmIProvider({ children }: { children: ReactNode }) {
  // Created once per provider (research R3) so a StrictMode double-mount
  // effect below still shares the same store, and therefore load()'s own
  // idempotence, rather than each mount getting its own in-flight fetch.
  const [store] = useState(() => createWhoAmIStore(() => apiGet<WhoAmI>('/whoami')));
  const state = useSyncExternalStore(store.subscribe, store.getState);

  useEffect(() => {
    void store.load();
  }, [store]);

  // Memoized so consumers reading this via useContext don't see a new
  // object identity on every render of an unrelated ancestor -- only when
  // the store's own state actually changes, or the store itself does.
  const value = useMemo(() => ({ ...state, refresh: store.refresh }), [state, store]);

  return <WhoAmIContext.Provider value={value}>{children}</WhoAmIContext.Provider>;
}

export function useWhoAmI(): WhoAmIContextValue {
  const ctx = useContext(WhoAmIContext);
  if (!ctx) throw new Error('useWhoAmI must be used within a WhoAmIProvider');
  return ctx;
}
