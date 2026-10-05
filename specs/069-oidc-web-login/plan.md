# Implementation Plan: Web UI login through Bellhop's own OIDC client

**Branch**: `issue-69-oidc-web-login` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/069-oidc-web-login/spec.md`

## Summary

Replace the web UI's trust in `X-authentik-*` forward-auth headers with Bellhop signing users in itself as an Authentik OIDC client (authorization-code + PKCE). Identity lives in server-side sessions in `data/sessions.sqlite3`, addressed by an opaque `HttpOnly`/`Secure`/`SameSite=Lax` cookie. A session is silently re-checked with the refresh token every 5 minutes (groups refreshed, refusal ends the session) and capped at 30 days. Auth modes become `oidc | none` (unset = `none`). A `configure-web-login` command stores the client's issuer, id, secret and callback URL from the existing `sync-authentik` machinery. The Windows firewall rule loses its proxy-IP scoping. Tests and the demo authenticate through real sessions. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js (versions in CI), ESM run through `tsx`

**Primary Dependencies**: Express 5, `ws`, `better-sqlite3`, `zod`; new: `openid-client` ^6 (brings `jose`)

**Storage**: new `data/sessions.sqlite3` (sessions, login attempts); settings store in `inventory/bellhop.db` (`meta` and `secret_settings`) gains four keys

**Testing**: `node --test` via `npm test`; supertest-style requests against `buildApp`; an in-process fake OIDC provider for `RealWebLoginClient`; `FakeWebLoginClient` for route tests

**Target Platform**: the Bellhop web service (Windows service today, LXC per #67), browsers at desktop and ≤640px widths

**Project Type**: web service + React client + CLI

**Performance Goals**: one provider round trip (refresh + userinfo) per session per 5 minutes; none on other requests

**Constraints**: no secret or token in any response/log/error; Bellhop's auth must not read `X-authentik-*`; deterministic tests (injected clock, no network beyond 127.0.0.1)

**Scale/Scope**: a handful of users, one instance

## Constitution Check

| Principle | Status |
|---|---|
| I. No real operational data | Pass. Discovery fixture captured live and redacted (`authentik.example.com`, slug `bellhop`); all docs/specs use `example.com`. |
| II. Code quality | Pass. One OIDC wrapper (`RealWebLoginClient`), one session store, one cookie helper shared by Express and the WebSocket path; zod validates settings; errors name the fix. Web authz treated as a correctness requirement. |
| III. Testing | Pass. Every behavior has tests; the real OIDC client is tested against a local provider serving the captured discovery shape; tokens/JWKS are generated per run (keys cannot be captured). Live sign-in verified manually (quickstart §4) and recorded in the PR, as for other real network clients. Clock injected for re-check/expiry tests. |
| IV. UX consistency | Pass. `configure-web-login` dry-runs by default with `--apply`; CLI-only (no second front end, so no `Operation` needed). Settings guard messages name the fix. UI changes (Sign out button, Settings fields) verified at desktop and mobile widths. Docs updated in the same change. |

Post-design re-check: unchanged, no violations.

## Project Structure

### Documentation (this feature)

```text
specs/069-oidc-web-login/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-auth.md
│   └── cli-and-settings.md
└── tasks.md
```

### Source Code (repository root)

```text
src/web/login/
├── cookies.ts            # parse Cookie header; cookie names/options
├── session-store.ts      # SQLite sessions + login_attempts (hashing, expiry, purge)
├── oidc-client.ts        # WebLoginClient interface + RealWebLoginClient (openid-client)
├── sessions.ts           # SessionService: resolve(cookie) with single-flight re-check
└── config.ts             # webLoginConfig(): the four settings, "configured" + missing keys
src/web/routes/auth.ts    # /auth/login, /auth/callback, /auth/logout, /auth/signed-out
src/web/auth.ts           # requireAuth/resolveRequestUser rewrite; modes; viaOidc
src/web/app.ts            # mount /auth before requireAuth; sessions/webLogin deps
src/web/server.ts         # open data/sessions.sqlite3; boot checks; pass to WS
src/web/routes/jobs.ts    # WS upgrade resolves the session cookie
src/web/routes/settings.ts# new lockout guard; drop derived.proxy
src/web/impersonation.ts  # comments (keyed by session username)
src/lib/settings-defs.ts  # modes oidc|none; four new keys
src/lib/inventory.ts      # one-time webUiAuthMode migration
src/commands/networking/configure-web-login.ts
src/commands/networking/sync-authentik.ts  # + scope-offline_access
src/cli.ts                # register configure-web-login
scripts/windows-service.ts# drop remoteip/resolveProxyIp
scripts/demo/*            # seeded session instead of headers; example OIDC settings
web-client/src/...        # 401 → /auth/login; Sign out form; Settings fields; mode labels
test/support/web-session.ts, test/support/fake-web-login-client.ts, test/support/fake-oidc-provider.ts
test/web/login/*.test.ts, test/web/routes/auth.test.ts, test/commands/configure-web-login.test.ts
docs/authentik.md, docs/environment-variables.md, docs/configuration.md, docs/web-ui.md,
docs/reverse-proxy/haproxy.md, docs/commands.md, SECURITY.md, README.md (commands table if listed),
src/web/CLAUDE.md, src/commands/networking/CLAUDE.md, src/lib/CLAUDE.md, web-client/CLAUDE.md
```

**Structure Decision**: the login subsystem gets its own `src/web/login/` directory (five focused files) so `src/web/auth.ts` stays the request-identity seam it already is; routes follow the existing `src/web/routes/` layout.

## Implementation phases

1. **Foundations** (no behavior change yet): `openid-client` dependency; settings keys and modes with migration; cookie helper; `SessionStore`; `WebLoginClient` + `RealWebLoginClient` tested against the fake provider; `SessionService` with re-check rules; test helpers.
2. **US1 sign-in**: `/auth/login` + `/auth/callback`; `requireAuth` rewrite (session → dev user → none → 401/redirect); WS upgrade; `buildApp`/`server.ts` wiring; convert all web tests from headers to sessions; headers-ignored tests.
3. **US2 sign-out and re-check**: `/auth/logout`, `/auth/signed-out`; re-check behavior through `requireAuth` (groups refresh, refusal, unreachable, 30-day cap, single-flight).
4. **US3 configure**: `configure-web-login`; `offline_access` mapping in `sync-authentik`; Settings page fields.
5. **US4 lockout guard**: Settings PATCH guard and client confirm text.
6. **US5 modes**: boot checks/warning for `none`; env rejection; banner unchanged; client 401 redirect and Sign out form.
7. **US6 proxy/firewall**: Windows firewall rule; remove `derived.proxy`.
8. **Demo, docs, CLAUDE.md**, screenshots, single-operator note (the session store assumes one service process).
9. **Verification**: typecheck, tests, web build, browser at desktop/mobile, live quickstart §4 where possible.

## Complexity Tracking

No constitution violations.
