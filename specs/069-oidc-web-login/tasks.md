---

description: "Task list for web UI login through Bellhop's own OIDC client (#69)"
---

# Tasks: Web UI login through Bellhop's own OIDC client

**Input**: Design documents from `specs/069-oidc-web-login/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-auth.md, contracts/cli-and-settings.md, quickstart.md

**Tests**: Required. The constitution (Principle III) requires automated tests with every behavior change. Within each story, write the tests first and confirm they fail before implementing.

**Organization**: Tasks are grouped by user story (spec.md). Paths are repo-relative to the worktree.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 from spec.md

---

## Phase 1: Setup

- [x] T001 Add `openid-client` ^6 to `dependencies` in package.json (run `npm install`, commit package-lock.json); confirm it imports under `tsx` with `npm run typecheck`

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: settings and modes, cookie helper, session store, OIDC client wrapper, session service and test helpers. No request-path behavior changes yet.

### Tests first

- [x] T002 [P] Tests in test/lib/settings-defs.test.ts and test/lib/config.test.ts: `webUiAuthMode` accepts only `oidc` and `none` (message `must be one of: oidc, none`); new keys `webUiOidcIssuer` (http(s) URL), `webUiOidcClientId` (non-empty), `webUiOidcRedirectUri` (http(s) URL "whose path is `/auth/callback`"), secret `webUiOidcClientSecret` ("non-empty, no whitespace"), env vars `WEB_UI_OIDC_ISSUER`/`WEB_UI_OIDC_CLIENT_ID`/`WEB_UI_OIDC_REDIRECT_URI`/`WEB_UI_OIDC_CLIENT_SECRET`, group `general`, envFile `authentik.env`
- [x] T003 [P] Test in test/lib/inventory.test.ts: opening a database whose `meta.webUiAuthMode` is `authentik` rewrites it to `oidc`; `auto` deletes the row; `oidc`/`none`/absent untouched; running twice is a no-op; a log line names what changed
- [x] T004 [P] Tests in test/web/login/cookies.test.ts: parse `Cookie` headers (multiple cookies, spaces, `=` in values, missing header, malformed pairs ignored); exported names `bellhop_session`/`bellhop_login` and option objects (`httpOnly`, `secure`, `sameSite: 'lax'`, path `/` with maxAge 30 days for the session; path `/auth` with maxAge 600 s for login)
- [x] T005 [P] Tests in test/web/login/session-store.test.ts (`':memory:'`, injected clock): create returns a 32-byte base64url id and stores only its SHA-256 hex; get by raw id; session valid while `now < created_at + 30 days`, deleted on sight after; update after re-check; markAttempt sets `last_attempt_at`; delete; purge removes expired sessions and attempts; login attempts are single-use (`consumeAttempt` reads and deletes in one transaction) and invalid after 10 minutes; persists across reopen of a file-backed store in a `mkdtempSync` dir
- [x] T006 [P] Fake provider test support in test/support/fake-oidc-provider.ts: Express on 127.0.0.1 port 0 serving test/fixtures/authentik/oidc-discovery.json with every endpoint URL rewritten to the local origin (and issuer `<origin>/application/o/bellhop/`), a JWKS for an RSA key generated per run (via `jose`), and authorization/token/userinfo/end-session handlers controllable per test (claims, groups, refresh rotation, refusal with `invalid_grant`, 5xx, omitting the refresh token, a `sub` mismatch); records requests
- [x] T007 Tests in test/web/login/oidc-client.test.ts against the fake provider (T006), with `allowInsecureRequests` passed only via the constructor option: `startLogin` builds an authorization URL with `response_type=code`, the configured `redirect_uri`, `scope=openid profile email offline_access`, `state`, `nonce`, S256 `code_challenge`; `completeLogin` exchanges the code with the verifier, rejects a bad signature/issuer/audience/nonce/expired ID token and a state mismatch, returns `{ username, uid, email, groups, refreshToken, idToken }` built from userinfo with ID-token fallback, fails without `preferred_username`, fails with a message naming the `offline_access` scope mapping when no refresh token is returned; `recheck(refreshToken, sub)` returns fresh identity plus the rotated refresh token, returns `{ kind: 'refused' }` on `invalid_grant`/`invalid_client`/userinfo 401/`sub` mismatch and `{ kind: 'unreachable' }` on network error/5xx; `endSessionUrl` returns the provider URL with `id_token_hint` and `post_logout_redirect_uri`, or undefined when not advertised; discovery cached per `(issuer, clientId, clientSecret)` and not cached on failure; no thrown error message contains the client secret or any token
- [x] T008 Tests in test/web/login/sessions.test.ts for `SessionService.resolve(rawId)` with a `FakeWebLoginClient` and injected clock: unknown/expired → undefined; check not due (< 5 min since `last_checked_at`) → stored identity, no provider call; due → `recheck` called once, identity replaced, `last_checked_at` updated, refresh token rotated; refused → session deleted, undefined; unreachable → stored identity returned, `last_attempt_at` set, `logWarn` naming the issuer only, no retry within 1 minute; two concurrent resolves of one due session share a single `recheck` call; returned `AuthUser` has `viaOidc: true` and `uid`

### Implementation

- [x] T009 [P] In src/lib/settings-defs.ts set `WEB_UI_AUTH_MODES = ['oidc', 'none']` (refine message `must be one of: oidc, none`), add the four keys to `MovedSettingsSchema`/`SecretSettingsSchema` and `SETTING_DEFS` per data-model.md; update any exhaustive key lists the typecheck or existing tests flag (test/lib/secret-leak.test.ts, config-import)
- [x] T010 [P] Add `migrateWebUiAuthMode(db)` beside `migrateCaddyToProxy` in src/lib/inventory.ts, called from `openInventoryDb` (`authentik` → `oidc`, delete `auto`, `logInfo` what changed)
- [x] T011 [P] Implement src/web/login/cookies.ts (parser, names, options)
- [x] T012 [P] Implement src/web/login/session-store.ts (`SessionStore` over better-sqlite3, WAL, tables `sessions`/`login_attempts` exactly as data-model.md, injected `now`)
- [x] T013 [P] Implement src/web/login/config.ts: `webLoginConfig(env?)` returning `{ configured: true, issuer, clientId, clientSecret, redirectUri } | { configured: false, missing: ConfigKey[] }` through `configValue`
- [x] T014 Implement src/web/login/oidc-client.ts: `WebLoginClient` interface (`startLogin`, `completeLogin`, `recheck`, `endSessionUrl`) and `RealWebLoginClient` over `openid-client` (the only importer of it), per research R1/R2/R4/R7/R15
- [x] T015 Implement src/web/login/sessions.ts: `SessionService` (resolve with re-check rules and single-flight map, create from a completed login, destroy) per data-model.md
- [x] T016 [P] Test helpers: test/support/fake-web-login-client.ts (scriptable `WebLoginClient`) and test/support/web-session.ts (`newTestSessions()` → in-memory store + service with a fake client; `sessionCookie(sessions, { username, groups, uid?, email? })` → `Cookie` header value)

**Checkpoint**: `npm run typecheck` and the new tests pass; nothing reads the new modules yet except tests.

---

## Phase 3: User Story 1 — Sign in through Authentik (P1) 🎯 MVP

**Goal**: in `oidc` mode a browser signs in through Authentik and lands on the page it asked for; APIs and the job stream require the session; headers are ignored.

**Independent Test**: spec US1; route tests with `FakeWebLoginClient` plus quickstart §4 steps 1–3.

### Tests first

- [x] T017 [P] [US1] Tests in test/web/routes/auth.test.ts for `GET /auth/login` and `GET /auth/callback` per contracts/http-auth.md: not-configured page lists missing keys and both fixes; discovery failure → 502 page naming the issuer; redirect + `bellhop_login` cookie; `returnTo` kept only for same-origin paths (`/jobs?x=1` kept; `//evil.example`, `/\evil`, `https://evil.example`, `javascript:` → `/`); callback success sets `bellhop_session` with HttpOnly/Secure/SameSite=Lax and redirects to `returnTo`; missing/unknown/expired/used attempt, state mismatch, provider `error`, `completeLogin` failure → 400 page with retry link and no session; no response body contains a secret or token
- [x] T018 [P] [US1] Tests in test/web/auth.test.ts (rewrite): resolution order session → `WEB_UI_DEV_USER` → local operator in `none` → unauthenticated; `oidc` mode unauthenticated `/api/*` → 401 JSON, other GET → 302 `/auth/login?returnTo=<path+query>`, POST to non-api → 401; `x-authentik-username`/`-groups`/`-uid` headers have no effect in either mode; session identity carries `uid` and `viaOidc`; `/auth/*` reachable without a session
- [x] T019 [P] [US1] Tests in test/web/jobs-ws.test.ts: upgrade with a valid `bellhop_session` cookie accepted; without it, or with only `x-authentik-*` headers, destroyed; impersonation overlay still applied
- [x] T020 [P] [US1] Tests in test/web/impersonation.test.ts and test/web/routes/impersonation.test.ts converted to sessions: store keyed by the session username; `resolveTriggeredBy`/`resolveActor` give the real session user with `uid`

### Implementation

- [x] T021 [US1] Rewrite src/web/auth.ts: `AuthMode = 'oidc' | 'none'` (unset → `none`; env `auto`/`authentik` throw `WEB_UI_AUTH_MODE=<v> is no longer supported -- use oidc (sign-in required) or none (no authentication); see docs/authentik.md`), delete `forwardAuthIdentity` and every header read, replace `viaForwardAuth` with `viaOidc`, `requireAuth` built from a `SessionService` (`requireAuth(sessions)` factory) with the unauthenticated responses in contracts/http-auth.md
- [x] T022 [US1] Implement `GET /auth/login` and `GET /auth/callback` in src/web/routes/auth.ts (small inline HTML pages, escaped output)
- [x] T023 [US1] Wire src/web/app.ts: `AppDeps.sessions?: SessionService` (default: in-memory store + `RealWebLoginClient`) and `webLogin?: WebLoginClient`; mount `/auth` routes before `requireAuth`; keep `/api` config-snapshot invalidation ahead of both
- [x] T024 [US1] Wire src/web/server.ts: open `data/sessions.sqlite3` (fail start-up if it cannot be opened), build `RealWebLoginClient` and `SessionService`, pass to `buildApp` and `attachJobsWebSocket`; replace the boot warning with one for `none` mode only
- [x] T025 [US1] Authenticate the upgrade in src/web/routes/jobs.ts (`attachJobsWebSocket` takes the `SessionService`; parse the cookie with src/web/login/cookies.ts; await resolve before the visibility check)
- [x] T026 [US1] Update src/web/impersonation.ts comments (keyed by session username, not a header)
- [x] T027 [US1] Convert every web test that authenticates with `x-authentik-*` headers to `sessionCookie` (pass `sessions` in `buildApp` deps): test/web/app.test.ts and test/web/routes/{app-updates,auth-groups,dashboard,groups,jobs,maintenance,oidc,permissions,provisioning,settings,tasks,users}.test.ts; tests asserting the old `auto`/`authentik` modes are rewritten to the new rules, not deleted
- [x] T028 [US1] Update src/commands/maintenance/backfill-guest-creators.ts and test/commands/backfill-guest-creators.test.ts if they reference removed auth exports (keep `localOperatorUsername`)

**Checkpoint**: full `npm test` green; sign-in works end to end against the fake client.

---

## Phase 4: User Story 2 — Sign out, and access that follows Authentik (P1)

**Goal**: sign-out ends the session (and Authentik's); re-checks keep groups current and end refused sessions; restarts keep sessions.

**Independent Test**: spec US2; quickstart §4 steps 4–7.

### Tests first

- [x] T029 [P] [US2] Tests in test/web/routes/auth.test.ts for `POST /auth/logout` (session deleted, cookie cleared, 303 to end-session URL with `id_token_hint` and `post_logout_redirect_uri=<origin of redirect URI>/auth/signed-out`, else 303 `/auth/signed-out`; provider unreachable still clears; no session still 303) and `GET /auth/signed-out`; a logged-out cookie then gets 401
- [x] T030 [P] [US2] Request-level tests in test/web/auth.test.ts with injected clock: after 5 minutes a request triggers a re-check and sees new groups (admin removed → `/api/settings` 403); refused re-check → 401 and session gone; unreachable → served with last-known identity; 30-day-old session → 401; a file-backed session survives building a second app on the same store (restart)

### Implementation

- [x] T031 [US2] Implement `POST /auth/logout` and `GET /auth/signed-out` in src/web/routes/auth.ts
- [x] T032 [US2] Inject the clock through `SessionService`/`AppDeps` where T030 needs it; ensure the purge runs at store open and on sign-in

---

## Phase 5: User Story 3 — Configure the client in one step (P2)

**Goal**: `configure-web-login` stores issuer, client id, secret and callback URL; `sync-authentik` grants `offline_access`; Settings shows the new fields.

**Independent Test**: spec US3; dry run then `--apply` against a fixture inventory with `FakeAuthentikClient`.

### Tests first

- [x] T033 [P] [US3] Tests in test/commands/configure-web-login.test.ts (temp inventory, `FakeAuthentikClient`): dry run prints the three non-secret values and `webUiOidcClientSecret: (would be set)`, writes nothing; `--apply` stores all four (secret via `writeSecret`), output never contains the secret; errors for unknown entry, not OIDC, no client yet, Authentik unconfigured, no `/auth/callback` redirect URI (message per contracts/cli-and-settings.md), each writing nothing
- [x] T034 [P] [US3] Update test/commands/sync-authentik.test.ts (and fixtures-based tests) for `scope-offline_access` in `OIDC_SCOPE_MAPPINGS`: created providers carry four mappings; an existing provider missing it gets a drift patch appending it
- [x] T035 [P] [US3] Tests in test/web-client/settings-display.test.ts: General tab lists `webUiAuthMode`, `webUiOidcIssuer`, `webUiOidcClientId`, `webUiOidcRedirectUri`, `webUiOidcClientSecret`; effective mode defaults to `none`

### Implementation

- [x] T036 [US3] Implement src/commands/networking/configure-web-login.ts (`runConfigureWebLogin(entry, { apply }, deps)` reusing `runOidcCredentials` and the writers `runSetConfig` uses) and register `configure-web-login <entry>` with `--apply` in src/cli.ts
- [x] T037 [US3] Add `goauthentik.io/providers/oauth2/scope-offline_access` to `OIDC_SCOPE_MAPPINGS` in src/commands/networking/sync-authentik.ts
- [x] T038 [US3] Settings UI: add the four fields to the General tab in web-client/src/lib/settings-display.ts (secret rendered like other secrets) and any labels/help in web-client/src/pages/SettingsPage.tsx and web-client/src/api/types.ts; mode options `oidc`/`none`

---

## Phase 6: User Story 4 — Switching modes without lockout (P2)

**Goal**: the Settings page refuses `oidc` unless configured and an admin is signed in; CLI unrestricted.

**Independent Test**: spec US4 scenarios via `PATCH /api/settings`.

### Tests first

- [x] T039 [P] [US4] Tests in test/web/routes/settings.test.ts: PATCH `webUiAuthMode: 'oidc'` refused (409) with each of the three messages in contracts/cli-and-settings.md (incomplete settings, counting values set in the same PATCH; no session (dev user / local operator); session user non-admin under post-save groups); accepted for a session admin with a `logWarn` naming them; already-`oidc` resend not refused; impersonating admin judged by the real identity; set-config unrestricted (test/commands/set-config.test.ts)
- [x] T040 [P] [US4] Tests in test/web-client/settings-display.test.ts: confirm prompt fires when leaving `oidc` and its text says the web UI will be reachable without sign-in

### Implementation

- [x] T041 [US4] Replace the `authentik` guard in src/web/routes/settings.ts with the `oidc` guard (uses `webLoginConfig` on post-PATCH values and `(req.realUser ?? req.user).viaOidc`)
- [x] T042 [US4] Update the leave-mode confirm in web-client/src/lib/settings-display.ts and its use in web-client/src/pages/SettingsPage.tsx

---

## Phase 7: User Story 5 — Running without an identity provider (P3)

**Goal**: `none` is the default with warning and banner; removed values handled; the client follows 401s and signs out through Bellhop.

**Independent Test**: spec US5; `npm run web:dev`, and a 401 in the browser redirecting to sign-in.

### Tests first

- [x] T043 [P] [US5] Tests in test/web/auth.test.ts: unset mode → `none`; env `auto`/`authentik` throw naming `oidc`/`none`; stored invalid value error names `set-config`
- [x] T044 [P] [US5] Tests in test/web-client (new test/web-client/api-client.test.ts or existing pattern): a 401 from `apiGet`/`apiPost`/`apiPatch`/`apiPut` sets `location.href` to `/auth/login?returnTo=<encoded path+search>`; Sidebar renders a POST form to `/auth/logout` for non-local-operator users and nothing for the local operator (test/web-client/admin-nav.test.ts or a Sidebar test following the repo's existing web-client test style)

### Implementation

- [x] T045 [US5] 401 redirect in web-client/src/api/client.ts
- [x] T046 [US5] Sign out form button in web-client/src/components/Sidebar.tsx (styled as the previous link; works at ≤640px)
- [x] T047 [US5] Mode default/labels in web-client/src/lib/settings-display.ts (`effectiveWebUiAuthMode` falls back to `none`)

---

## Phase 8: User Story 6 — Same login under every proxy; firewall (P3)

**Goal**: firewall rule open to any address; no proxy-IP derivation.

**Independent Test**: spec US6; firewall command string and Settings API shape.

### Tests first

- [x] T048 [P] [US6] Tests: the firewall rule command built by scripts/windows-service.ts has no `remoteip=` (extract a pure `firewallRuleCommand(port)` and test it in test/scripts/windows-service.test.ts); `GET /api/settings` has no `derived.proxy` (test/web/routes/settings.test.ts)

### Implementation

- [x] T049 [US6] Drop `resolveProxyIp` and `remoteip=` in scripts/windows-service.ts
- [x] T050 [US6] Remove `derived.proxy` from `derivedValues()` in src/web/routes/settings.ts and the "Proxy IP (firewall scope)" line in web-client/src/pages/SettingsPage.tsx (and its type in web-client/src/api/types.ts)

---

## Phase 9: Polish & cross-cutting

- [x] T051 Demo: in scripts/demo/demo-server.ts replace `DEMO_IDENTITY_HEADERS` with a seeded admin session (in-memory store, cookie injected by the same middleware; identity `admin`/`admin@example.com`/`bellhop-admins`, a fixed example `uid`), and in scripts/demo/demo-inventory.ts set `webUiAuthMode: 'oidc'` with `webUiOidcIssuer: https://authentik.example.com/application/o/bellhop/`, `webUiOidcClientId: example-client-id`, `webUiOidcRedirectUri: https://bellhop.example.com/auth/callback` and an example secret; update test/scripts/demo/demo-server.test.ts and test/scripts/demo/demo-inventory.test.ts
- [x] T052 [P] Docs: docs/authentik.md (web login setup sequence from quickstart §4, modes, "Locked out" recovery via `set-config webUiAuthMode none --apply` or the env var, group freshness of 5 minutes, sessions file), docs/environment-variables.md, docs/configuration.md (new keys; `data/authentik.env`'s `WEB_UI_AUTH_MODE` values), docs/web-ui.md, docs/reverse-proxy/haproxy.md "Limits" (no `proxyManual` needed for Bellhop), docs/commands.md (`configure-web-login`), SECURITY.md, README.md commands table if it lists networking commands; also any other docs page `git grep -n "WEB_UI_AUTH_MODE\|forward-auth headers\|remoteip"` finds
- [x] T053 [P] Guidance files: rewrite "Web UI authentication", "webUiAuthMode", "WebSocket path", "Firewall scope and HAProxy", impersonation and Settings-guard bullets in src/web/CLAUDE.md; add `configure-web-login` and the `offline_access` mapping to src/commands/networking/CLAUDE.md; settings keys in src/lib/CLAUDE.md; Sign out/401 in web-client/CLAUDE.md; root CLAUDE.md mental-model line if it mentions headers; add a "Single-operator assumptions" note that sessions and re-check single-flighting assume one service process; CONTRIBUTING.md if it restates header auth for tests
- [ ] T054 Regenerate screenshots with `npm run docs:screenshots` for changed screens (Sidebar, Settings General) and check them by eye for example-only values
- [ ] T055 Run `npm run typecheck`, `npm test`, `npm run web:build`; `git grep -n "x-authentik" src/web web-client/src` returns nothing
- [ ] T056 Browser check (desktop width and ≤640px) of the Sidebar Sign out button, Settings General fields, the not-configured and sign-in-failed pages
- [ ] T057 Live verification per quickstart §4 where possible on the deployment checkout, recording results for the PR (never seeding real values into tracked files)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. T007 depends on T006 and T014; T008 on T015/T016 skeletons; T014 on T001.
- US1 (Phase 3) depends on Phase 2 and blocks US2 (logout and request-level re-check build on `requireAuth`).
- US3, US4, US5, US6 depend on Phase 2 and on T021 (modes); otherwise independent of each other. US4's guard uses US3's settings keys (T009 already in Phase 2).
- Polish after all stories.

## Parallel Opportunities

- Phase 2 tests T002–T006 in parallel; implementations T009–T013 in parallel.
- US1 tests T017–T020 in parallel.
- US3 (T033–T035), US5 web-client tests (T044), US6 (T048) are in separate files and can proceed in parallel once US1 lands.

## Parallel Example: Phase 2

```text
Task: "T004 cookie tests in test/web/login/cookies.test.ts"
Task: "T005 session store tests in test/web/login/session-store.test.ts"
Task: "T006 fake provider in test/support/fake-oidc-provider.ts"
```

## Implementation Strategy

MVP = Phases 1–3 (sign-in replaces header trust, tests converted). Then US2 (sign-out and re-check, needed before deploying), US3 (one-step configuration), US4 (lockout guard), US5/US6, then demo, docs and verification. Commit per phase as `<what it delivers> (#69, USn)`, with the `tasks.md` checkbox updates in the same commit.
