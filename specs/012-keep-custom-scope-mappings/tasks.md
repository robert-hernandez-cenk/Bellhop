---

description: "Task list for keeping custom OpenID scope mappings (issue #16)"
---

# Tasks: Keep custom scope mappings on an OpenID client

**Input**: Design documents from `specs/012-keep-custom-scope-mappings/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md

**Tests**: required — the issue's acceptance criteria are unit tests. Write each test first
and see it fail before implementing.

**Organization**: Tasks are grouped by user story. All paths are relative to the worktree
root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

- [ ] T001 Create `test/fixtures/authentik/propertymappings-scope.json` from the live capture described in research.md R1 (a read-only `GET /api/v3/propertymappings/provider/scope/?page_size=100`), redacted per constitution Principle I: every `pk` replaced by an obviously fake UUID in the `00000000-0000-4000-8000-0000000000NN` style other fixtures use, the custom (`managed: null`) mapping's `name`/`description`/`expression` replaced by example values (e.g. name `example-app email (verified via social source)`), built-in mappings kept as captured. Keep the `pagination`/`results`/`autocomplete` top-level shape and every result key.

---

## Phase 2: Foundational (listing the scope mappings)

**Purpose**: `listScopeMappings` replaces `getScopeMappingIds`, and `resolveOidcInstanceSettings` returns a `scopeNameById` map. Blocks every story.

- [x] T002 Write failing tests in `test/lib/authentik-client.test.ts` (use the existing `withStubbedFetch` helper and `FIXTURES_DIR`): `RealAuthentikClient.listScopeMappings()` against the T001 fixture returns `{ id, managed?, scopeName }` per result (`pk` -> `id`, `managed: null` -> `managed` absent, `scope_name` -> `scopeName`) and requests `/api/v3/propertymappings/provider/scope/?page_size=100`; and it throws a message containing "pagination is not implemented" when `pagination.count` exceeds `results.length`.
- [x] T003 In `src/lib/authentik-client.ts`: add exported `AuthentikScopeMapping { id: string; managed?: string; scopeName: string }`; replace `getScopeMappingIds(managed)` on the `AuthentikClient` interface, `RealAuthentikClient`, and `UnconfiguredAuthentikClient` with `listScopeMappings(): Promise<AuthentikScopeMapping[]>`. The real one reads the truncation count from `pagination.count` (research R1 — there is no top-level `count`), keeps the same error wording, and its comment says why. Update the `findPolicyByName` comment that lists `getScopeMappingIds` among the top-level-`count` readers.
- [x] T004 [P] In `test/support/fake-authentik-client.ts`: change the `scopeMappings` seed to `AuthentikScopeMapping[]`, default the three built-ins with the existing ids (`scope-openid-1`/`openid`, `scope-profile-1`/`profile`, `scope-email-1`/`email`, each with its `goauthentik.io/providers/oauth2/scope-<name>` managed id); implement `listScopeMappings()`; remove `getScopeMappingIds`; update the read-only-lookups comment.
- [x] T005 In `src/commands/networking/sync-authentik.ts`: `resolveOidcInstanceSettings` calls `listScopeMappings()` once, resolves the `OIDC_SCOPE_MAPPINGS` ids by `managed` (throwing `No Authentik scope property mapping found for managed id '<id>'` for the first missing one, so the `missing-scope-mapping` reason text is unchanged), and returns `scopeNameById: ReadonlyMap<string, string>` (every listed id -> scope name) on the `ok: true` variant of `OidcInstanceSettings`.
- [x] T006 Update the `missing-scope-mapping` test in `test/commands/sync-authentik.test.ts` to seed `scopeMappings` in the new list form (only `openid`/`profile` built-ins) and keep asserting the reason matches `/scope-email/`. Run `npm run typecheck` and `npm test`; T002 passes.

**Checkpoint**: listing works end to end; behavior otherwise unchanged.

---

## Phase 3: User Story 1 — A synced client keeps its custom scope mapping (P1) 🎯 MVP

**Goal**: drift on `property_mappings` is checked by scope name.

**Independent Test**: an owned client with a custom `email` mapping reports no drift on sync.

- [x] T007 [US1] Write failing unit tests for `diffOAuth2Settings(current, desired, scopeNameById)` in `test/commands/sync-authentik.test.ts` (update the existing diff test to pass a `scopeNameById` built from the three built-ins): (a) a custom mapping for a required scope → no `property_mappings` change; (b) a required scope with no mapping → `property_mappings` reported, patch = current ids in order followed by the built-in id of each missing scope; (c) an extra mapping for an unrequired scope (e.g. `offline_access`) → no change; (d) an attached id absent from `scopeNameById` is kept and covers no scope.
- [x] T008 [US1] Write failing sync tests in `test/commands/sync-authentik.test.ts`: an owned OIDC client whose mappings are `scope-openid-1`, `scope-profile-1` and a seeded custom `email`-scope mapping yields `oidcUpdates: []` on dry run and apply, and its `propertyMappingIds` are unchanged afterwards; an owned client with `scope-openid-1`, `scope-profile-1` and an `offline_access` mapping gets `property_mappings` drift and, after apply, holds its old ids followed by `scope-email-1`. Adjust the existing drift test near the `['scope-email-1', 'scope-openid-1']` fixture so its expectation matches the new rule (the missing `profile` scope is appended, existing ids kept).
- [x] T009 [US1] Implement the rule in `diffOAuth2Settings` in `src/commands/networking/sync-authentik.ts` per data-model.md "Scope coverage rule" (required third parameter; required names from `desired.propertyMappingIds`; patch keeps current order and appends missing built-ins). Update its comment (research R4 note now: scope mappings compared by scope name). Pass `scopeNameById` from `planOidc` to both `diffOAuth2Settings` calls (owned drift and orphan reuse).

**Checkpoint**: US1 tests pass.

---

## Phase 4: User Story 2 — Adopting a client with a custom mapping keeps it (P1)

**Independent Test**: adoption preview for a client differing only by a custom `email` mapping lists only the marker.

- [x] T010 [US2] Write a failing test in `test/commands/adopt-oidc-client.test.ts`: an adoptable unmarked client matching the desired settings except a custom `email` mapping (seeded in `scopeMappings`) in place of `scope-email-1`; the preview's OpenID settings changes are empty (only the `meta_publisher` marker is set), and after apply the client's `propertyMappingIds` are unchanged.
- [x] T011 [US2] Pass `instance.scopeNameById` to `diffOAuth2Settings` in `src/commands/networking/adopt-oidc-client.ts`.

---

## Phase 5: User Story 3 — New clients are unchanged (P2)

- [x] T012 [US3] Add or confirm a test in `test/commands/sync-authentik.test.ts` that a newly created OIDC client carries exactly `['scope-openid-1', 'scope-profile-1', 'scope-email-1']` even when the instance also lists a custom `email` mapping.

---

## Phase 6: Polish

- [ ] T013 [P] Update README.md's "OIDC mode" section: scope-mapping drift is checked by scope name; a custom mapping for `openid`/`profile`/`email` is kept (example: a custom `email` mapping setting `email_verified`), a missing scope gets the built-in mapping added, and Bellhop no longer restores a built-in mapping that was swapped for another with the same scope name.
- [ ] T014 [P] Update CLAUDE.md's `sync-authentik` bullet (the `diffOAuth2Settings` sentence and the "fixed openid/profile/email scope mappings" sentence) with the same rule and trade-off, and note that `listScopeMappings` reads `pagination.count`.
- [ ] T015 Run `npm run typecheck` and `npm test`; run the quickstart.md manual dry run (`npm run bellhop -- sync-authentik`, read-only) from the worktree and record the result.

---

## Dependencies & Execution Order

- T001 → T002 → T003; T004 in parallel with T003; T005 after T003/T004; T006 after T005.
- US1 (T007–T009) after Phase 2. US2 (T010–T011) after T009 (shares `diffOAuth2Settings`). US3 (T012) after T009.
- Polish after all stories.

## Parallel Example

```text
T003 (src/lib/authentik-client.ts) alongside T004 (test/support/fake-authentik-client.ts)
T013 (README.md) alongside T014 (CLAUDE.md)
```

## Implementation Strategy

MVP is Phase 2 + US1: every sync keeps custom mappings. US2 and US3 then come for free
through the shared diff and are mostly tests.
