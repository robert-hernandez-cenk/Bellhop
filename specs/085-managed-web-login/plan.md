# Implementation Plan: Bellhop-Managed Web Login

**Branch**: `issue-85-managed-web-login` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/085-managed-web-login/spec.md`

## Summary

Flag one guest as Bellhop's own (`bellhop: true`). When the four custom
`webUiOidc*` settings are not all set, the web login derives issuer, client
ID, secret and redirect URI from that guest's Authentik OpenID client, read
live through the existing `runOidcCredentials` and cached in memory only.
`webLoginConfig()` stays synchronous: it prefers a complete custom set, else
the cached managed value; the async refresh runs at startup, at the start of
`/auth/login`, and before a due session re-check. The custom settings move to
a new `weblogin` settings group (a "Web login" tab) that reports the active
source. The `webUiAuthMode: oidc` PATCH guard counts a usable managed login;
`configure-web-login` is removed. See [research.md](research.md) for the
decisions.

## Technical Context

**Language/Version**: TypeScript (strict), Node ESM, React client in `web-client/`

**Primary Dependencies**: express, zod, better-sqlite3, the existing `AuthentikClient`, `openid-client`-based `RealWebLoginClient` (no new dependencies)

**Storage**: `inventory/bellhop.db` (SQLite): one new nullable `guests.bellhop` column added by `ensureColumn`; managed credentials are never stored

**Testing**: `node --test` under `test/`; fake `AuthentikClient`, temp SQLite fixtures, existing `FakeWebLoginClient`-style doubles in `test/web/login/` and `test/web/routes/auth.test.ts`; no new third-party response shapes (see Constitution Check)

**Target Platform**: Bellhop web service (Linux guest or Windows workstation) and CLI

**Project Type**: web-service + CLI + React client (existing monorepo layout)

**Performance Goals**: sign-in adds at most one Authentik credentials lookup (three list calls and one credentials call); re-checks add one only when the cached value is older than the 5-minute re-check interval

**Constraints**: secrets never in responses, logs or errors; `webLoginConfig()` must remain synchronous (MCP authorization server consumes it synchronously); custom values win

**Scale/Scope**: one operator, one Bellhop guest, one web origin

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| I. No real data | Spec, plan and fixtures use `bellhop.example.com`, `pve1`, `<client-secret>` placeholders only. Pass. |
| II. Code quality | Flag validated by zod and `validateInventory()` (the cross-entry at-most-one rule lives there, like `proxy`/`authentik`). Errors name the fix. Shared logic: the credentials lookup stays `runOidcCredentials`; the callback-URL picker moves from the removed command into the new managed module, one copy. No new remote-execution path. Pass. |
| III. Testing | Tests ship with each story. Third-party fixture rule: no new Authentik response shape is consumed (the existing `getOAuth2Credentials` is reused unchanged), so no new captured fixture is needed; recorded in research R6. The `Ssh2SSHClient`/real-client exception is untouched. Pass. |
| IV. UX consistency | The flag is one field of the guest-edit `Operation` used by web and MCP, validated once. Error messages name the setting/tab to fix. Secrets stay write-only (nothing new accepted). UI verified at desktop and 640px. README/docs/CLAUDE.md updated in the same change. No infra mutation, so no dry-run surface. Pass. |

No violations; Complexity Tracking is empty.

**Post-design re-check (after Phase 1)**: unchanged. The design adds one
in-process module and one column, and removes one command.

## Project Structure

### Documentation (this feature)

```text
specs/085-managed-web-login/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── guest-edit.md
│   ├── settings-api.md
│   └── cli.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/inventory.ts                       # bellhop flag: schema (guest), column, load/save, validateInventory
src/lib/settings-defs.ts                   # webUiOidc* group -> 'weblogin'
src/web/login/managed.ts                   # NEW: callbackUri picker, resolve/refresh/cache, status
src/web/login/config.ts                    # webLoginConfig(): custom-first, else managed cache
src/web/login/sessions.ts                  # await refresh before a due re-check
src/web/routes/auth.ts                     # await refresh at /auth/login (and callback)
src/web/server.ts                          # configure the managed module; startup refresh
src/web/routes/settings.ts                 # webLogin status in the response; PATCH guard
src/web/routes/dashboard.ts                # admin-only check covers `bellhop`
src/operations/edit-guest.ts               # `bellhop` field (web + MCP)
src/mcp/build-server.ts                    # tool description mentions the field
src/commands/networking/configure-web-login.ts   # REMOVED (+ cli.ts registration)
web-client/src/pages/SettingsPage.tsx, lib/settings-display.ts, api/types.ts   # Web login tab, status line
web-client/src/ (guest Advanced modal)     # "This is Bellhop" toggle
docs/, README.md, CONTRIBUTING.md if it lists it, nested CLAUDE.md files

test/lib/inventory.test.ts, test/web/login/managed.test.ts (new), config.test.ts,
test/web/routes/{auth,settings,dashboard}.test.ts, test/operations/*, test/web-client/settings-display.test.ts,
test/commands/configure-web-login.test.ts (REMOVED), demo tests
```

**Structure Decision**: the existing single-repo layout; one new module
(`src/web/login/managed.ts`) beside `config.ts`, the one place that knows about
web login sources.

## Complexity Tracking

None.
