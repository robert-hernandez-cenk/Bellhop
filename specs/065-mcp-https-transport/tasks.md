---
description: "Task list for MCP over HTTPS with sign-in and an API-key fallback"
---

# Tasks: MCP over HTTPS with sign-in and an API-key fallback

**Input**: `specs/065-mcp-https-transport/` (spec.md, plan.md, research.md, data-model.md, contracts/http-mcp.md, quickstart.md)

**Tests**: required (constitution Principle III, TDD): each implementation task is preceded by its failing test.

**Format**: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Confirm the baseline in the worktree: `npm run typecheck` and `npm test` pass before any change (recorded: 3056 pass, 0 fail)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: the HTTP host and route skeleton every story runs through, plus the `buildMcpServer` options they need.

- [ ] T002 Test then add `buildMcpServer` options `actor?: { username: string }` and `tracker?: PromptTracker` in `src/mcp/build-server.ts` (default tracker built per server as today; `previewAndEnqueue` gets `triggeredByUsername: actor.username`, falling back to `'mcp'` until T020), tests in `test/mcp/build-server.test.ts`
- [ ] T003 Test then implement `McpHttpHost` in `src/web/mcp/http-host.ts`: map `Mcp-Session-Id` → `{ transport, server, principal, username, lastSeen }`; new session only for an `initialize` request without a session id (else 400); unknown id → 404; principal mismatch → 403; one shared `PromptTracker`; `sweep(now)` closes sessions idle ≥ 30 minutes, run by an unref'd 60 s interval; `close()` for shutdown/tests. Tests in `test/web/mcp/http-host.test.ts` drive it through the SDK `Client` + `StreamableHTTPClientTransport` against an Express app on `127.0.0.1:0`
- [ ] T004 Test then implement `mcpRoutes(deps)` in `src/web/mcp/routes.ts` with a pluggable verifier: fail-closed guard (contract step 1: `503` with the exact message naming `configure-web-login` and `mcpApiKey`), `requireBearerAuth` (contract step 2–3), then `McpHttpHost`; cookies never authenticate. Tests in `test/web/mcp/routes.test.ts`
- [ ] T005 Mount `mcpRoutes` in `buildApp` (`src/web/app.ts`) before `requireAuth`, with `invalidateConfigSnapshot` applied to `/mcp`; wire the web service's `JobRunner`/deps in `src/web/server.ts`; add `AppDeps` fields; test that `/mcp` is reachable without a cookie in `oidc` mode and that `/api` still requires one, in `test/web/mcp/routes.test.ts`

**Checkpoint**: `/mcp` serves MCP to a test verifier; stdio untouched.

---

## Phase 3: User Story 3 — Headless access with an API key (P2, built first because US1's verifier extends it)

**Goal**: `mcpApiKey` authenticates `/mcp`; write-only everywhere; Generate on the Settings page.

**Independent Test**: quickstart §2.

- [ ] T006 [US3] Test then add secret `mcpApiKey` to `SecretSettingsSchema`/`SETTING_DEFS` in `src/lib/settings-defs.ts`: env `MCP_API_KEY`, group `mcp` (extend `SettingGroup`), validation "no whitespace, ≥ 32 characters" with fixed messages; tests in `test/lib/settings-defs.test.ts` (and any exhaustive key-list tests that need the new key)
- [ ] T007 [US3] Test then implement the key verifier in `src/web/mcp/api-key.ts`: SHA-256 both sides, `timingSafeEqual`, principal `api-key`, username `api-key`; read through `configValue('mcpApiKey')` per request; tests in `test/web/mcp/api-key.test.ts` (match, mismatch, unset, env override, cleared key refused)
- [ ] T008 [US3] Use the key verifier in `mcpRoutes`; end-to-end tests in `test/web/mcp/routes.test.ts`: key works (`get_inventory`), wrong key 401, neither configured 503, key-only 401 has no `resource_metadata`
- [ ] T009 [US3] Test that `GET /api/settings` reports `secrets.mcpApiKey` as `{ set, source }` only and `PATCH` validates/stores/clears it with no value echoed, in `test/web/routes/settings.test.ts`; adjust `src/web/routes/settings.ts` only if needed
- [ ] T010 [P] [US3] Add the **MCP** tab to `SETTINGS_TABS`/`fieldsForTab` in `web-client/src/lib/settings-display.ts` (+ its test), and the `mcpApiKey` field help (endpoint shape `https://<bellhop address>/mcp`, header `Authorization: Bearer <key>`, link to docs) in `web-client/src/pages/SettingsPage.tsx`
- [ ] T011 [US3] Add a **Generate** button to the `mcpApiKey` `SecretField` in `web-client/src/pages/SettingsPage.tsx`: 32 bytes from `crypto.getRandomValues`, base64url, shown in a revealed input until saved, never fetched from the server; helper `generateApiKey()` in `web-client/src/lib/settings-display.ts` with a test
- [ ] T012 [US3] Test that `set-config mcpApiKey <value>` is refused as an argument and `--stdin --apply` stores it, and that MCP `set_config`'s key enum excludes it, in `test/commands/maintenance/set-config.test.ts` / `test/mcp/build-server.test.ts`

**Checkpoint**: headless MCP over HTTP works end to end.

---

## Phase 4: User Story 1 — Connect an MCP client by signing in (P1)

**Goal**: standard MCP OAuth flow with Bellhop as authorization server and Authentik sign-in.

**Independent Test**: test/web/mcp/oauth-flow.test.ts drives register → authorize → consent → callback → token → `get_inventory`; quickstart §3 manually.

- [ ] T013 [US1] Test then add hash-keyed lookups to `SessionStore` (`getSessionByHash`, `updateAfterCheckByHash`, `markCheckAttemptByHash`, `deleteSessionByHash`, keeping the cookie-keyed methods as wrappers) and `SessionService.resolveHash(idHash)` sharing the single-flight map, in `src/web/login/session-store.ts`/`sessions.ts`; tests in `test/web/login/session-store.test.ts`, `sessions.test.ts`
- [ ] T014 [US1] Test then add `login_attempts.mcp_pending_hash TEXT NULL` (`ensureColumn`) and carry it through `createAttempt`/`consumeAttempt` in `src/web/login/session-store.ts`
- [ ] T015 [US1] Test then implement `McpAuthStore` in `src/web/mcp/auth-store.ts` over the same `data/sessions.sqlite3` handle (tables per data-model.md: `mcp_clients`, `mcp_pending`, `mcp_codes`, `mcp_grants`, `mcp_access_tokens`; every token-like value stored as SHA-256 hex; injected clock): register/get client (purge unused registrations older than 24 h on each registration), create/consume pending (10 min), issue/consume code (single use, 10 min), create grant + tokens (access 1 h), rotate refresh (old refresh dead), resolve access token, revoke; tests in `test/web/mcp/auth-store.test.ts`
- [ ] T016 [US1] Test then implement the consent page and `POST /auth/mcp/consent` in `src/web/mcp/consent.ts` (per-pending cookie `bellhop_mcp_<prefix>` path `/auth`, HttpOnly, SameSite=Lax, Secure except loopback; zod-validated form; deny → `error=access_denied`; approve → start Authentik sign-in like `/auth/login` with the attempt carrying the pending hash; expired/mismatch → 400 page), mounted from `src/web/routes/auth.ts`; tests in `test/web/mcp/consent.test.ts`
- [ ] T017 [US1] Test then branch `GET /auth/callback` in `src/web/routes/auth.ts` for MCP attempts: create the dedicated session (raw id hashed and discarded, no cookie set, existing cookie untouched), issue a code, `302` to `redirect_uri?code&state`
- [ ] T018 [US1] Test then implement `BellhopOAuthProvider` in `src/web/mcp/oauth-provider.ts` (`clientsStore`, `authorize` → consent page, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `revokeToken`, `verifyAccessToken` = key first, then access token → grant → `resolveHash` → principal `grant:<id>`, username); tests in `test/web/mcp/oauth-provider.test.ts`
- [ ] T019 [US1] Mount the SDK `mcpAuthRouter` lazily in `mcpRoutes`, cached by issuer = origin of `webUiOidcRedirectUri` (not mounted when sign-in is unconfigured; SDK rate limits kept with the `X-Forwarded-For` validation off); bearer `resourceMetadataUrl` = `<origin>/.well-known/oauth-protected-resource/mcp`; end-to-end flow test in `test/web/mcp/oauth-flow.test.ts` (discovery shapes per contract, register, authorize page, deny, approve, callback, token, refresh rotation and reuse refused, revoke, MCP call; web sign-out leaves MCP working)

**Checkpoint**: a client can sign in and use every tool.

---

## Phase 5: User Story 2 — Only admins, and only while they stay admins (P1)

**Independent Test**: oauth-flow tests for a non-admin and a demoted admin.

- [ ] T020 [US2] Test then refuse a non-admin at the MCP callback (403 page naming both admin groups; dedicated session deleted; no code) in `src/web/routes/auth.ts`
- [ ] T021 [US2] Test then refuse per request: `verifyAccessToken` throws `InsufficientScopeError` (403) when the re-checked identity is no longer admin and `InvalidTokenError` (401, grant deleted) when the session is gone (refused re-check, 30 days), in `src/web/mcp/oauth-provider.ts`; tests in `test/web/mcp/oauth-flow.test.ts` with an injected clock and `FakeWebLoginClient` recheck results
- [ ] T022 [US2] Test that an MCP session opened by one principal refuses another's token or the API key (403), in `test/web/mcp/http-host.test.ts`

---

## Phase 6: User Story 4 — Know who did what, and from where (P2)

**Independent Test**: jobs from web, HTTP MCP (sign-in and key) and stdio record the right user and front end.

- [ ] T023 [P] [US4] Test then add `jobs.triggered_via TEXT NULL` (`ensureColumn`), `JobRow.triggeredVia: 'web' | 'mcp' | null`, `JobDefinition.triggeredVia?` in `src/web/jobs/job-store.ts`/`job-runner.ts`; tests in `test/web/jobs/job-store.test.ts`
- [ ] T024 [US4] `resolveTriggeredBy` returns `triggeredVia: 'web'` (`src/web/impersonation.ts`), scheduler's daily run unchanged (no front end) in `src/web/tasks/scheduler.ts`; tests for a web job and a scheduled run
- [ ] T025 [US4] `buildMcpServer` enqueues with `triggeredVia: 'mcp'` and `actor.username`; HTTP host passes the session's username (`api-key` for the key); stdio `src/mcp/server.ts` passes `os.userInfo().username`; `summarizeJob` in `src/mcp/job-helpers.ts` includes `triggeredVia`; tests in `test/mcp/build-server.test.ts`, `test/mcp/job-helpers.test.ts`, `test/web/mcp/routes.test.ts`
- [ ] T026 [P] [US4] Show the front end next to the username in `web-client/src/pages/JobHistory.tsx` and the job detail header (find where `triggeredByUsername` renders), `triggeredVia` in `web-client/src/api/types.ts`; label helper with a test
- [ ] T027 [US4] `backfill-guest-creators` skips `triggeredVia === 'mcp'` as well as username `mcp`, in `src/commands/maintenance/backfill-guest-creators.ts` with a test

---

## Phase 7: User Story 5 — Long-running jobs and prompts for remote clients (P2)

**Independent Test**: two sessions waiting on one prompting job; one dialog; disconnect leaves the job running.

- [ ] T028 [US5] Test over HTTP in `test/web/mcp/http-host.test.ts`: two sessions call `wait_for_job` on one job that pauses (HangingSSHClient / scripted prompt): exactly one elicitation request; the answer resumes the job; closing both transports leaves the job running and owned by the web runner
- [ ] T029 [US5] Test the 30-minute idle sweep closes a session and a later request with its id gets 404, in `test/web/mcp/http-host.test.ts`

---

## Phase 8: Polish & cross-cutting

- [ ] T030 [P] Docs: `docs/mcp-server.md` (remote connection: sign-in flow, API key, admins only, proxy route must pass `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`; loopback `[::1]` limitation), `docs/configuration.md` (MCP tab, `mcpApiKey`), `docs/environment-variables.md` (`MCP_API_KEY`), README main-commands/doc index line if needed (stay ≤ 200 lines)
- [ ] T031 [P] Guidance: `src/mcp/CLAUDE.md` (two transports, actor, shared tracker), `src/web/CLAUDE.md` (MCP HTTP host, authorization server, consent, single-operator assumptions: in-process sessions and tracker), `src/lib/CLAUDE.md` (fifth→sixth secret, `mcp` group), `web-client/CLAUDE.md` (MCP tab, Generate), `src/web/jobs/CLAUDE.md` (`triggered_via`)
- [ ] T032 Run `npm run typecheck`, `npm test`, `npm run web:build`; paste results
- [ ] T033 Browser check of the Settings MCP tab and job list at desktop and ≤ 640px (quickstart §2, §4)
- [ ] T034 Live verification with a real MCP client through the proxy (quickstart §3) — requires the deployed service; record as unverified in the PR if not done

## Dependencies

- Phase 2 blocks everything. US3 (Phase 3) before US1 (the provider's `verifyAccessToken` extends the key verifier). US2 depends on US1. US4 and US5 depend only on Phase 2 (US4's T025 also on T002). Polish last.

## Parallel examples

- T010 (client tab) alongside T007–T009 (server key).
- T023 and T026 alongside Phase 4.
- T030 and T031 together.

## Implementation strategy

MVP = Phase 2 + US3 (headless HTTP MCP with a key), then US1+US2 (sign-in, admin-only) as the primary path, then US4/US5 and docs. Commit per phase.
