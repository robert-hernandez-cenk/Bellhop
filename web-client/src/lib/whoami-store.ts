import type { WhoAmI } from '../api/types.ts';

export interface WhoAmIState {
  whoami: WhoAmI | null;
  loading: boolean;
  error: string | null;
  generation: number;
}

export interface WhoAmIStore {
  getState(): WhoAmIState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  refresh(): Promise<void>;
}

const INITIAL_STATE: WhoAmIState = { whoami: null, loading: true, error: null, generation: 0 };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Framework-free (research R2): the React binding in whoami.tsx wraps this
// with useSyncExternalStore rather than reimplementing any of these rules
// itself, so they stay testable with plain node --test.
export function createWhoAmIStore(fetchWhoAmI: () => Promise<WhoAmI>): WhoAmIStore {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  // Bumped on every fetch this store starts (load or refresh); a settling
  // fetch that isn't the latest one anymore is a stale response and is
  // ignored (contract rule 6) rather than overwriting a newer result.
  let requestId = 0;
  // load() is idempotent (research R3): the first call starts the fetch and
  // caches its promise so StrictMode's double-invoked mount effect -- and
  // any other caller -- only ever triggers one fetchWhoAmI() call.
  let loadPromise: Promise<void> | null = null;

  function setState(next: WhoAmIState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  async function run(bumpGeneration: boolean): Promise<void> {
    const id = ++requestId;
    if (bumpGeneration) {
      // refresh() always fetches, keeping the current whoami until this
      // request settles (data-model.md's "refresh() start" transition).
      setState({ ...state, loading: true });
    }
    try {
      const whoami = await fetchWhoAmI();
      if (id !== requestId) return; // a newer request already started
      setState({ whoami, loading: false, error: null, generation: bumpGeneration ? state.generation + 1 : state.generation });
    } catch (err) {
      if (id !== requestId) return;
      setState({ whoami: null, loading: false, error: errorMessage(err), generation: bumpGeneration ? state.generation + 1 : state.generation });
    }
  }

  return {
    getState(): WhoAmIState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(): Promise<void> {
      if (!loadPromise) loadPromise = run(false);
      return loadPromise;
    },
    refresh(): Promise<void> {
      return run(true);
    },
  };
}
