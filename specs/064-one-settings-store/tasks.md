---

description: "Task list for #64 -- one settings store with write-only secrets"
---

# Tasks: One settings store, with write-only secrets

**Input**: Design documents from `specs/064-one-settings-store/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required (constitution Principle III). Each story writes its tests first (TDD), then the
implementation. All tests use temp SQLite fixtures (`mkdtempSync` + `bellhop.db`), stubbed `fetch`,
and example values only (Principle I). Reset the process-wide store with `useConfigStore(null)` in
every test that registers one.

**Worktree**: `C:\Users\rcher\Dev\Bellhop-Worktrees\issue-64-one-settings-store` -- every path below
is relative to it.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Baseline: `npm run typecheck` and `npm test` pass in the worktree before any change (2580 pass, 2 skipped)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: setting definitions, the secret table, and the accessor every story reads through.

- [ ] T002 Write tests in test/lib/settings-defs.test.ts: every moved/secret key has an env var, group and secret flag exactly as data-model.md's table; `SETTINGS_KEYS` includes the 12 non-secret moved keys; `SECRET_SETTINGS_KEYS` is exactly `authentikApiToken`, `cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken`; validation rules verbatim from data-model.md ("http(s) URL" for `authentikApiUrl`/`npmApiUrl`; "positive integer string" for `authentikOutpostPort`; "`auto` | `authentik` | `none`" for `webUiAuthMode`; "non-empty, no whitespace" for the three tokens; "non-empty, no control chars" for `npmApiPassword`; "non-empty" for the rest); a zod failure message never contains the input value
- [ ] T003 Create src/lib/settings-defs.ts (leaf module, imports only zod): `MovedSettingsSchema`, `SecretSettingsSchema`, `SECRET_SETTINGS_KEYS`, and a `SETTING_DEFS` record `{ envVar, group: 'general'|'proxy'|'authentik'|'cloudflare'|'nginx-proxy-manager'|'github', secret }` for every moved/secret key; spread `MovedSettingsSchema.shape` into `SettingsSchema` in src/lib/inventory.ts (research R1/R2)
- [ ] T004 Write tests in test/lib/config.test.ts: `effectiveValue` precedence (env non-empty > stored > none; empty env = unset); `configValue` with no store registered reads env only; with a registered temp DB it reads `meta` and `secret_settings`; a malformed stored row throws naming the key and env var but not the value; snapshot reused within 2 s (inject clock), refreshed after `invalidateConfigSnapshot()`, and refreshed after `writeSecret`/`clearSecret`/`saveInventory` in-process; `storedSecretKeys` returns keys only; no DB file -> everything `none` and no file created
- [ ] T005 Create src/lib/config.ts per contracts/config-accessor.md (`useConfigStore`, `configValue`, `configValueAt`, `effectiveValue`, `invalidateConfigSnapshot`, `writeSecret`, `clearSecret`, `storedSecretKeys`), 2 s TTL snapshot keyed by database path with injectable clock, read-only open that tolerates a missing `secret_settings` table; add `CREATE TABLE IF NOT EXISTS secret_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)` to `SCHEMA` in src/lib/inventory.ts and call `invalidateConfigSnapshot()` at the end of `saveInventory`
- [ ] T006 Test + change the #158 migration in src/lib/inventory.ts to read the ladder from the database being opened (`meta` row `authentikGroupLadder`) through `effectiveValue` with env override (FR-020); test in test/lib/inventory.test.ts: stored ladder used with no env; env wins over stored; default when neither
- [ ] T007 Extend `settingFix` in src/lib/settings-hint.ts to accept secret keys (secret hint: `--stdin`), test in test/lib/settings-hint.test.ts

**Checkpoint**: store + accessor exist; nothing reads them yet; full suite still green.

---

## Phase 3: User Story 1 + User Story 5 -- settings read through one accessor, environment overrides (P1/P3)

**Goal**: every moved value is read at point of use from env-then-settings; a saved value applies
on the next request; env-pinned fields are reported and refused on web write.

**Independent test**: register a temp store, write `authentikAdminGroup` via the settings API, the
next request's `isAdminUser` uses it; with `AUTHENTIK_ADMIN_GROUP` set, the API reports
`environment` and PATCH is refused.

- [ ] T008 [P] [US1] Tests in test/lib/authentik-config.test.ts: `authentikConfig()`/`authentikConfigured()` read stored values when a store is registered, env overrides, defaults unchanged, malformed stored `authentikOutpostPort` throws naming the key; existing env-param tests unchanged
- [ ] T009 [US1] Change src/lib/authentik-config.ts so every field (and `authentikConfigured`) reads through `configValue(key, env)`
- [ ] T010 [P] [US1] Tests in test/web/auth.test.ts: `authMode()` reads `webUiAuthMode` from the store, env `WEB_UI_AUTH_MODE` wins, invalid env still throws; `resolveAuthUser` sets `viaForwardAuth: true` only for the `x-authentik-username` branch (not dev user, not local operator)
- [ ] T011 [US1] Change src/web/auth.ts: `authMode` via `configValue('webUiAuthMode', env)`; add `viaForwardAuth?: true` to `AuthUser`; confirm src/web/impersonation.ts's overlay preserves it (test in test/web/impersonation.test.ts)
- [ ] T012 [P] [US1] Tests in test/lib/live-client.test.ts and test/lib/authentik-client.test.ts / test/lib/cloudflare-client.test.ts: `buildAuthentikClient()`/`buildCloudflareClient()` return a client whose `isConfigured()` and requests follow a token/URL written after construction (no rebuild); env-param `buildCloudflareClient(env)` still works
- [ ] T013 [US1] Create src/lib/live-client.ts (`liveClient<T extends object>(build: () => T): T`, one documented cast); make `buildAuthentikClient` (src/lib/authentik-client.ts) and `buildCloudflareClient` (src/lib/cloudflare-client.ts) live via the accessor; update src/cli.ts's own Authentik builder to use `buildAuthentikClient`
- [ ] T014 [P] [US1] Tests in test/lib/npm-client.test.ts: `buildNpmClient` reads `npmApiUrl`/`npmApiEmail`/`npmApiPassword` through the accessor; errors name the settings and the Settings page via `settingFix`, never a value, and no longer mention `data/nginx-proxy-manager.env`
- [ ] T015 [US1] Change src/lib/npm-client.ts (`resolveBaseUrl`, `buildNpmClient`, `NPM_UNCONFIGURED_MESSAGE`) accordingly
- [ ] T016 [US1] Invalidate the config snapshot at the start of every `/api` request in src/web/app.ts (next to `refreshInventory`); test in test/web/app.test.ts that a value written to the DB between two requests is used by the second
- [ ] T017 [P] [US5] Tests in test/web/routes/settings.test.ts: GET returns `sources` for every non-secret key and `environment` entries (`variable`, plus `value` for non-secret only) per contracts/settings-api.md; PATCH of an env-pinned key -> 400 naming the variable, nothing written; non-admin and impersonating admin still 403 on GET/PATCH
- [ ] T018 [US5] Implement `sources`/`environment` and the env-pinned refusal in src/web/routes/settings.ts; add `web-client/src/api/types.ts` fields
- [ ] T019 [P] [US5] Tests in test/commands/set-config.test.ts: a key whose env var is set in the CLI's environment is still stored, with the contract's warning
- [ ] T020 [US5] Implement the warning in src/commands/maintenance/set-config.ts

**Checkpoint**: US1/US5 complete for non-secret keys.

---

## Phase 4: User Story 2 -- secrets are write-only (P1)

**Goal**: secrets can be written from web and CLI, never read back anywhere.

**Independent test**: set every secret to a unique marker; search every output for it (T024).

- [ ] T021 [P] [US2] Tests in test/web/routes/settings.test.ts: GET `secrets` reports `{ set, source }` only; PATCH a secret stores it in `secret_settings` (not `meta`), returns no value, `null`/`''` clears; schema failure message has no value; env-pinned secret refused
- [ ] T022 [US2] Implement secret handling in src/web/routes/settings.ts (`writeSecret`/`clearSecret`, combined unknown-key check over both key lists)
- [ ] T023 [P] [US2] Tests in test/commands/set-config.test.ts and test/cli.test.ts: positional secret refused with the contract message; `--stdin` accepted (one trailing newline stripped, empty refused); no value + non-TTY + no `--stdin` refused; dry run prints `Would set <key> (value hidden)`; apply logs `Set <key> in <path>`; value never in any captured output; `--unset` clears
- [ ] T024 [US2] Implement in src/commands/maintenance/set-config.ts (secret branch writes via `writeSecret`/`clearSecret`) and src/cli.ts (`--stdin`, no-echo TTY prompt, never logs a secret)
- [ ] T025 [P] [US2] Test in test/mcp/build-server.test.ts: the `set_config` tool's key enum excludes every secret key, and no tool output contains a stored secret marker
- [ ] T026 [US2] Leak test test/lib/secret-leak.test.ts: seed every secret with a unique marker in a temp store, then assert the marker is absent from GET/PATCH `/api/settings` bodies, `loadInventory` result and its YAML (`stringify`), `runRenderStatusPage` HTML (FakeSSHClient history), a job's `argsJson`/log for a `set-config` MCP job, and captured `logInfo`/`logWarn` output during import and settings writes
- [ ] T027 [US2] Confirm `src/operations/networking.ts`'s `set-config` key enum stays `SETTINGS_KEYS` (non-secret only) and its apply log never prints a secret

**Checkpoint**: US2 complete.

---

## Phase 5: User Story 6 -- no self-lockout (P2)

- [ ] T028 [P] [US6] Tests in test/web/routes/settings.test.ts: changing `authentikAdminGroup`/`authentikBuiltinAdminGroup` so the real (non-impersonated) requester is no longer admin -> 409 with the contract message, nothing written; still-admin change succeeds; local operator never blocked; impersonating admin evaluated on real groups (but impersonation still 403s first); `webUiAuthMode: 'authentik'` from a request without forward-auth headers -> 409; from a request with `x-authentik-username` -> 200; clearing or setting `auto`/`none` -> 200
- [ ] T029 [US6] Implement both guards in src/web/routes/settings.ts (after schema validation, before any write)

---

## Phase 6: User Story 3 -- authenticated GitHub requests (P2)

- [ ] T030 [P] [US3] Tests in test/lib/github.test.ts: `githubApiHeaders()` adds `Authorization: Bearer <token>` iff `githubApiToken` is set (store or `GITHUB_API_TOKEN`), always sends `User-Agent: bellhop`, merges extra headers; `githubUnauthorizedError` names `githubApiToken` and the Settings page and never the token
- [ ] T031 [US3] Create src/lib/github.ts
- [ ] T032 [P] [US3] Tests in test/lib/app-source.test.ts, test/lib/app-update-check.test.ts, test/lib/script-catalog.test.ts: every `api.github.com` request (pin, compare, release latest/tag/list, contents listing) carries the header iff the token is set; `raw.githubusercontent.com` requests never do; a 401 produces the named error
- [ ] T033 [US3] Use `githubApiHeaders`/`githubUnauthorizedError` in src/lib/app-source.ts (`resolveHeadSha`, `compareBranch`), src/lib/app-update-check.ts (`githubGet` and its 401 handling), src/lib/script-catalog.ts (`fetchRepoSlugs`)

---

## Phase 7: User Story 4 -- import from data/*.env (P2)

- [ ] T034 [P] [US4] Tests in test/lib/config-import.test.ts: values imported for keys with no stored value (non-secret to `meta`, secret to `secret_settings`, `WEB_UI_AUTH_MODE` to `webUiAuthMode`); a stored value is never overwritten; second run imports nothing; files byte-identical afterwards; logs contain key/variable names only; invalid value skipped with a warning naming the key; no DB file -> no-op and no file created; real `process.env` values are not imported
- [ ] T035 [US4] Create src/lib/config-import.ts (`importEnvFiles(inventoryPath, dataDir)`, `dotenv.parse`)
- [ ] T036 [US4] Wire each entry point -- src/web/server.ts, src/cli.ts, src/mcp/server.ts, scripts/windows-service.ts: keep the dotenv loads (override), then `importEnvFiles`, then `useConfigStore(inventoryPath())`, before `loadInventory`; update their comments; test the CLI wiring in test/cli.test.ts (import runs, store registered)

---

## Phase 8: Web client -- Settings page (US1, US2, US5, US6)

- [ ] T037 [P] [US1] Tests in test/web-client/settings-display.test.ts: `SETTINGS_TABS` order General, Proxy, Authentik, Cloudflare, Nginx Proxy Manager, GitHub; `fieldsForTab` places every key (incl. each secret next to its integration's settings) in exactly one tab; `proxyFieldView` rules unchanged inside Proxy; `fieldState(key, data)` returns `env-pinned` (read-only, "set by environment") / editable; `needsConfirmation(key, current, next)` true for both admin-group fields and for `webUiAuthMode` leaving `authentik`
- [ ] T038 [US1] Implement those helpers in web-client/src/lib/settings-display.ts
- [ ] T039 [US2] Rework web-client/src/pages/SettingsPage.tsx: tab bar (wraps at <=640px), new field defs with help text for every moved key, `webUiAuthMode` as a `<select>`, secret field component (masked `type="password"` input, Replace/Save and Clear, shows set/not-set + source, input cleared after save, no reveal), env-pinned fields read-only with "set by environment" + variable name, `ConfirmModal`-style confirmation for the guarded fields; styles in web-client/src/index.css targeting `:root[data-theme='dark']` for dark
- [ ] T040 [US1] `npm run web:build` passes

---

## Phase 9: Demo, docs, polish

- [ ] T041 [P] Demo: scripts/demo/demo-server.ts registers the config store on its own inventory path and seeds example secrets in the "set" state (`cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken` -- not the Authentik token, since the demo injects an unconfigured Authentik client) and example non-secret values; stores `webUiAuthMode` instead of setting the env var where possible; extend test/scripts/demo/demo-server.test.ts / demo-inventory.test.ts for the example-only invariant
- [ ] T042 [P] Docs: docs/environment-variables.md (overrides + env-only list), docs/configuration.md (new settings, secrets, import, deleting the files, GitHub token note: fine-grained token with no repository permissions is enough for public repos), docs/web-ui.md (tabs, secret fields, env-pinned, guards), docs/authentik.md (settings instead of data/authentik.env, auth mode setting + lockout recovery), README.md quickstart if it mentions data/*.env
- [ ] T043 [P] CLAUDE.md: update every data/*.env passage (dotenv entry points, authentik-config.ts, Cloudflare/NPM clients, `WEB_UI_AUTH_MODE`, worktree seeding now just `bellhop.db`), remove the #63 unauthenticated-GitHub single-operator note, describe the store/accessor/snapshot/import; CONTRIBUTING.md if it restates env-file setup
- [ ] T044 Regenerate the Settings screenshot(s) under docs/images/ with `npm run docs:screenshots` if the Settings page is screenshotted; check example-only values by eye
- [ ] T045 Run quickstart.md: typecheck, full test suite, web:build; browser check of the Settings page at desktop and 375px, light and dark (dev server + demo); CLI `--stdin` and argv refusal; import against a copied database

---

## Dependencies & Execution Order

- Phase 2 blocks everything. Phase 3 (accessor consumers) before Phases 4-7. Phase 4 before
  Phase 5's tests that write secrets only if combined; Phases 5, 6, 7 are independent of each
  other. Phase 8 needs the API shape from Phases 3-5. Phase 9 last.
- Within a phase: test task first, then its implementation task.

## Parallel Opportunities

- T008, T010, T012, T014 (different test files) in parallel; T030/T032 and T034 in parallel with
  Phase 5; T041-T043 in parallel.

## Implementation Strategy

MVP = Phases 2-4 (one store, env override, write-only secrets). Then guards (5), GitHub (6),
import (7), UI (8), docs/demo (9). Commit per phase/story.
