---

description: "Task list for the shared whoami context"
---

# Tasks: Shared signed-in identity in the web UI

**Input**: Design documents from `specs/005-shared-whoami-context/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/whoami-store.md, quickstart.md

**Tests**: Required by the constitution (Principle III). The store's rules are tested with
`node --test`; rendering is verified in a browser (quickstart.md).

## Format: `[ID] [P?] [Story] Description`

Paths are relative to the repository root.

## Phase 1: Setup

- [ ] T001 Move the `WhoAmI` interface (and its comment) from `web-client/src/components/Sidebar.tsx` to `web-client/src/api/types.ts`, export it there, and change the `import type { WhoAmI } from './Sidebar'` / `'../components/Sidebar'` imports in `web-client/src/components/EditableAuthMode.tsx`, `web-client/src/components/OidcCredentials.tsx` and `web-client/src/pages/UsersPage.tsx` to import from `../api/types`. No behavior change; `npm run web:build` passes.

## Phase 2: Foundational (blocks both stories)

- [ ] T002 Write failing tests in `test/web-client/whoami-store.test.ts` (import `../../web-client/src/lib/whoami-store.ts`) for every rule in `contracts/whoami-store.md`: initial state `{ whoami: null, loading: true, error: null, generation: 0 }`; `load()` called repeatedly fetches once; `load()` never changes `generation`; `refresh()` always fetches and increments `generation` by 1 once settled, on success and on failure; failure sets `whoami: null` and `error` to the thrown error's message, later success clears it; an older response settling after a newer request started is ignored; listeners notified per change and not after unsubscribe; `load()`/`refresh()` never reject; `getState()` returns the same object between changes. Use example values only (`example-admin`, `example-group`). Run `npm test` and confirm they fail.
- [ ] T003 Implement `createWhoAmIStore(fetchWhoAmI)` in `web-client/src/lib/whoami-store.ts` per `contracts/whoami-store.md` and `data-model.md` (transitions table). Framework-free, no DOM APIs; `import type { WhoAmI } from '../api/types.ts'`. `refresh()` keeps the current `whoami` while loading and replaces it only when settled. Make T002 pass; `npm run typecheck` and `npm run web:build` pass.
- [ ] T004 Create `WhoAmIProvider` and `useWhoAmI()` in `web-client/src/lib/whoami.tsx`, following `web-client/src/lib/theme.tsx`: create the store once with `useState(() => createWhoAmIStore(() => apiGet<WhoAmI>('/whoami')))`, call `store.load()` in a mount effect, read state with `useSyncExternalStore(store.subscribe, store.getState)`, provide `{ ...state, refresh: store.refresh }`; `useWhoAmI()` throws `'useWhoAmI must be used within a WhoAmIProvider'` outside it.
- [ ] T005 In `web-client/src/App.tsx`, wrap the app in `WhoAmIProvider` (inside `ThemeProvider`, around `BrowserRouter`) and key `<main className="content">` on `generation` from `useWhoAmI()` (extract a small inner component so the hook runs inside the provider). The Sidebar stays outside `<main>`.

## Phase 3: User Story 1 — One identity answer for the whole page (P1) 🎯 MVP

**Goal**: every consumer reads the shared answer; no component fetches `/whoami` itself.

**Independent test**: quickstart.md rows 1–3.

- [ ] T006 [P] [US1] `web-client/src/components/Sidebar.tsx`: replace the `whoami` state and its `apiGet('/whoami')` call with `useWhoAmI()`; keep the `/provisioning` and `/maintenance` fetches; everything that reads `whoami` renders the same as before.
- [ ] T007 [P] [US1] `web-client/src/pages/UsersPage.tsx`: replace its `whoami` state and fetch with `useWhoAmI()`; `UsersSection`'s `whoamiUsername` and `GroupsSection`'s `adminGroups` props unchanged in meaning. Leave `GroupsSection.tsx` untouched (FR-011).
- [ ] T008 [P] [US1] `web-client/src/components/EditableAuthMode.tsx`: delete the local `useWhoAmI` helper and its comment; both components use the shared `useWhoAmI().whoami`, keeping `const isAdmin = !!whoami?.isAdmin` (null fails closed). Leave `EditableAuthGroup.tsx` untouched (FR-011).
- [ ] T009 [P] [US1] `web-client/src/components/OidcCredentials.tsx`: replace its `whoami` state and fetch with `useWhoAmI()`; keep `if (whoami === null) return null` (FR-009).
- [ ] T010 [US1] Confirm no `/whoami` fetch remains outside `web-client/src/lib/whoami.tsx` (`grep -rn "'/whoami'" web-client/src`), then run `npm run web:build` and `npm --prefix web-client run lint` (no warnings beyond the 3 existing `set-state-in-effect` ones).

## Phase 4: User Story 2 — Impersonation updates everything together, without a reload (P2)

**Goal**: start/stop impersonation refreshes the shared identity and remounts the page instead of reloading the browser; failures fail closed with a reachable retry.

**Independent test**: quickstart.md rows 4–6.

- [ ] T011 [US2] `web-client/src/components/Sidebar.tsx`: in `startImpersonating` and `stopImpersonating`, replace `window.location.reload()` with `await refresh()`, then reset `impersonateBusy` (and clear `impersonateTarget` after starting). On a rejected POST/DELETE keep today's error display and send no refresh.
- [ ] T012 [US2] `web-client/src/components/Sidebar.tsx`: when `useWhoAmI().error` is set, render a `warning-banner` naming the failure ("Couldn't load your sign-in details: <error>") with a Retry button calling `refresh()`, placed outside the impersonating/not-impersonating ternary so it is reachable in both states (FR-008). Match existing banner/button classes; add CSS in `web-client/src/index.css` only if needed, with dark variants under `:root[data-theme='dark']`.
- [ ] T013 [US2] Check the Sidebar's `/groups` effect still refetches correctly after stopping impersonation (it depends on `whoami?.impersonating`), and that the impersonate picker's selected group is cleared after a successful start.

## Phase 5: Polish & cross-cutting

- [ ] T014 [P] Update `CLAUDE.md`: in the "Web UI user/group management" paragraph, replace "both now read `isAdmin`/`adminGroups`/`capabilities` off `GET /api/whoami`" with the shared `WhoAmIProvider`/`useWhoAmI()` (`web-client/src/lib/whoami.tsx`, logic in `whoami-store.ts`); in the "Web UI admin user impersonation" paragraph, note that start/stop refreshes the shared identity and remounts the routed page rather than reloading the browser.
- [ ] T015 [P] Check `README.md` for any description of impersonation reloading the page or of per-component identity fetches; update if present (constitution IV), otherwise leave it.
- [ ] T016 Run `npm run typecheck`, `npm test`, `npm run web:build`, `npm --prefix web-client run lint`; all pass, no new lint warnings.
- [ ] T017 Browser verification per quickstart.md rows 1–6 at desktop width and at 375px; record request counts and results.

## Dependencies & Execution Order

- T001 → T002 → T003 → T004 → T005 → US1 (T006–T010) → US2 (T011–T013) → Polish (T014–T017).
- US2 edits the same `Sidebar.tsx` as T006, so it follows US1.
- T006–T009 touch different files and can run in parallel after T005.
- T014 and T015 can run in parallel with each other.

## Parallel Example: User Story 1

```text
T006 Sidebar.tsx | T007 UsersPage.tsx | T008 EditableAuthMode.tsx | T009 OidcCredentials.tsx
```

## Implementation Strategy

- MVP: Phases 1–3 (shared answer, no duplicate fetches). Impersonation still reloads the page at that point, which is correct, just not yet reload-free.
- Then Phase 4 removes the reload and adds the retry banner.
- Commit per phase: Setup + Foundational together, then US1, then US2, then Polish.
