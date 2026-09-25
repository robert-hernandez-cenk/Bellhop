# Implementation Plan: Shared signed-in identity in the web UI

**Branch**: `issue-13-shared-whoami-context` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-shared-whoami-context/spec.md`

## Summary

Replace the four per-component `GET /api/whoami` fetches in the web client with one shared
store. A framework-free `createWhoAmIStore(fetchWhoAmI)` in
`web-client/src/lib/whoami-store.ts` owns the state (`whoami`, `loading`, `error`,
`generation`) and the rules: an idempotent `load()` (so React StrictMode's double effect sends
one request), a `refresh()` that bumps `generation` whether it succeeds or fails, fail-closed
errors, and a sequence check so an older response never overwrites a newer one. A thin
`WhoAmIProvider` / `useWhoAmI()` in `web-client/src/lib/whoami.tsx` exposes it through React
context via `useSyncExternalStore`. `App.tsx` keys the routed `<main>` on `generation`, so a
refresh after an impersonation change remounts the current page (which refetches its
permission-filtered data) while the Sidebar stays mounted. The Sidebar's start/stop
impersonation calls `refresh()` instead of `window.location.reload()`, and shows a retry
banner when the lookup has failed.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React 19 + Vite

**Primary Dependencies**: existing only (React's `useSyncExternalStore`, `createContext`). No new dependencies.

**Storage**: none; in-memory client state only

**Testing**: `node --test` via the root `npm test` glob, with a new
`test/web-client/whoami-store.test.ts` importing the framework-free store directly (root
`tsconfig` includes `test/`, uses NodeNext, and allows `.ts` import extensions). Rendering
behavior is verified in a browser (constitution IV).

**Target Platform**: browsers served by the Bellhop web service

**Project Type**: web client of the existing CLI + web service + MCP project

**Performance Goals**: not a goal; request counts are correctness criteria (SC-001..SC-003)

**Constraints**: no server change; the store module must compile under both the web
client's bundler config and the root NodeNext config with no DOM lib (fetch function is
injected, type import uses an explicit `.ts` extension)

**Scale/Scope**: 1 new store, 1 provider, 6 edited client files, 1 new test file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Tests use example usernames/groups only (`example-admin`, `example-group`). |
| II. Code quality | PASS | One shared store replaces four copies (the "MUST NOT be copied between call sites" rule). Errors stay explicit: a failed lookup is surfaced in the Sidebar with a retry, never silently treated as admin. No server, remote-execution or validation-boundary change; `/whoami`'s response is same-origin and already typed as today. |
| III. Testing | PASS | The behavior change (single load, refresh, generation, fail-closed, stale-response guard) lives in a framework-free module covered by `node --test`; deterministic, no network (fetch is a stub). No component test tooling added (spec Assumptions). |
| IV. UX consistency | PASS | No CLI/MCP surface involved. Verified in a browser at desktop width and ≤640px. `CLAUDE.md` updated (architecture note on how components learn `isAdmin`); `README.md` checked for any description of the impersonation reload and updated if present. |
| Workflow | PASS | Worktree `issue-13-shared-whoami-context`, PR to `main`. No single-operator assumption introduced or changed. |

Post-design re-check: PASS. The design adds no persisted state, no dependency and no server change.

## Project Structure

### Documentation (this feature)

```text
specs/005-shared-whoami-context/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/whoami-store.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
web-client/src/lib/whoami-store.ts        # NEW: createWhoAmIStore (framework-free)
web-client/src/lib/whoami.tsx             # NEW: WhoAmIProvider, useWhoAmI
web-client/src/api/types.ts               # WhoAmI interface moved here from Sidebar.tsx
web-client/src/App.tsx                    # provider; <main key={generation}>
web-client/src/components/Sidebar.tsx     # hook; refresh() instead of reload; retry banner
web-client/src/pages/UsersPage.tsx        # hook instead of its own fetch
web-client/src/components/EditableAuthMode.tsx   # delete local useWhoAmI; use shared hook
web-client/src/components/OidcCredentials.tsx    # hook instead of its own fetch
test/web-client/whoami-store.test.ts      # NEW
CLAUDE.md (and README.md if it describes the reload)
```

**Structure Decision**: existing layout. The context follows `lib/theme.tsx`'s
provider/hook pattern; its logic is split into a sibling `.ts` module so the root test runner
can exercise it without a DOM.

## Complexity Tracking

No constitution violations.
