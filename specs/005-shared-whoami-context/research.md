# Research: Shared signed-in identity in the web UI

## R1. How the page refreshes after an impersonation change

- **Decision**: `refresh()` the shared identity, then remount the routed page by keying
  `<main className="content">` on a `generation` counter that only `refresh()` changes. The
  Sidebar sits outside `<main>` and updates in place.
- **Rationale**: Chosen by the user during brainstorming. Page data (Dashboard inventory,
  guest status, jobs) is filtered server-side by the viewer's groups, so updating only
  identity-driven controls would leave the page showing the admin's view while
  impersonating. Remounting reuses each page's existing mount-time fetch, with no per-page
  change.
- **Alternatives considered**: refresh-only (the issue's literal reading; stale page data);
  keeping `window.location.reload()` (drops the issue's "without a reload" criterion);
  keying on `whoami.impersonating` (would remount once on the first load of an
  already-impersonating session, violating FR-006).

## R2. Framework-free store plus thin React binding

- **Decision**: `createWhoAmIStore(fetchWhoAmI)` in a plain `.ts` module exposing
  `getState`/`subscribe`/`load`/`refresh`; the provider binds it with
  `useSyncExternalStore` and calls `load()` from an effect.
- **Rationale**: The constitution requires automated tests for behavior changes, and the
  web client has no component test tooling. Keeping the rules outside React lets the root
  `node --test` runner cover them. `useSyncExternalStore` is React's own API for external
  stores, and avoids calling `setState` inside an effect (the lint rule the web client
  already warns on).
- **Alternatives considered**: `useState` + `useEffect` inside the provider (untestable
  without a DOM; adds a `set-state-in-effect` warning); adding jsdom + Testing Library
  (out of scope for low-priority cleanup).

## R3. One request under React StrictMode

- **Decision**: `load()` is idempotent: the first call starts the fetch and caches the
  promise; later calls return it. The store is created once per provider
  (`useState(() => createWhoAmIStore(...))`).
- **Rationale**: StrictMode runs mount effects twice in development. A ref guard would also
  work, but idempotence inside the store is testable and keeps the provider trivial.

## R4. Failure behavior

- **Decision**: On failure the store sets `whoami: null` and `error: <message>`. `refresh()`
  bumps `generation` in both outcomes. A response from an older request is ignored if a
  newer one was started (sequence number).
- **Rationale**: Fail closed (FR-007): every consumer already treats a null identity as
  not-admin. Bumping on failure too keeps the page consistent with the server-side
  identity change that already happened. The Sidebar's retry (FR-008) reloads the page
  rather than calling `refresh()` -- a plain re-fetch can never recover an expired
  Authentik forward-auth session, since Caddy's login redirect only works on a top-level
  navigation, and the banner only appears once the identity has already failed to load, so
  there's no in-page state a reload would lose -- and is rendered outside the impersonation
  banner, so it stays reachable.
- **Alternatives considered**: keeping the previous `whoami` on refresh failure (could show
  admin controls after impersonation started, i.e. fail open).

## R5. Importing a web-client module from the root test runner

- **Decision**: The store uses only `import type { WhoAmI } from '../api/types.ts'` and no
  DOM APIs; the fetch function is injected. The test imports it by relative path with the
  `.ts` extension.
- **Rationale**: Root `tsconfig` includes `test/` with NodeNext resolution (explicit
  extensions required) and `allowImportingTsExtensions`; the web client's bundler config
  also allows `.ts` extensions and requires `import type` (`verbatimModuleSyntax`).
  `api/types.ts` has no imports, so the root typecheck pulls in nothing else.

## R6. Components the issue listed that need no change

- `GroupsSection.tsx` never fetches `/whoami`; it receives `adminGroups` as a prop from
  `UsersPage`, which will read the shared hook.
- `EditableAuthGroup.tsx` never fetches `/whoami`; it uses `canLower` from
  `/auth-groups`, which it needs for the ladder anyway and which is admin-equivalent.
  Both are left unchanged (FR-011).
