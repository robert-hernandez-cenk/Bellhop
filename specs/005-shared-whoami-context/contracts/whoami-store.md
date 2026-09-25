# Contract: whoami store and hook

## `web-client/src/lib/whoami-store.ts`

```ts
export interface WhoAmIState {
  whoami: WhoAmI | null;
  loading: boolean;
  error: string | null;
  generation: number;
}

export interface WhoAmIStore {
  getState(): WhoAmIState;                       // stable reference between changes
  subscribe(listener: () => void): () => void;   // returns unsubscribe
  load(): Promise<void>;                         // idempotent; first call fetches
  refresh(): Promise<void>;                      // always fetches; bumps generation when settled
}

export function createWhoAmIStore(fetchWhoAmI: () => Promise<WhoAmI>): WhoAmIStore;
```

Rules (each covered by `test/web-client/whoami-store.test.ts`):

1. Initial state is `{ whoami: null, loading: true, error: null, generation: 0 }`.
2. `load()` called any number of times calls `fetchWhoAmI` once.
3. `load()` never changes `generation`.
4. `refresh()` calls `fetchWhoAmI` every time and increments `generation` by 1 once settled,
   on success and on failure.
5. A failure sets `whoami: null` and `error` to the thrown error's message (or its string
   form); a later success clears `error`.
6. A response from an older request that settles after a newer request started is ignored.
7. Listeners are notified on every state change and not after unsubscribing.
8. `load()` and `refresh()` never reject.

## `web-client/src/lib/whoami.tsx`

```ts
export function WhoAmIProvider(props: { children: ReactNode }): JSX.Element;
export function useWhoAmI(): WhoAmIState & { refresh: () => Promise<void> };
```

- The provider creates one store with `apiGet<WhoAmI>('/whoami')` and calls `load()` on mount.
- `useWhoAmI()` throws outside the provider, like `useTheme()`.

## App shell

- `<main className="content">` is keyed on `generation`; the Sidebar is outside it.
