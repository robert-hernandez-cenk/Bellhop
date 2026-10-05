# Research: Web UI login through Bellhop's own OIDC client (#69)

## R1. OIDC library

**Decision**: `openid-client` 6.x (panva; ESM, fetch-based, depends on `jose`), wrapped behind a small `WebLoginClient` interface in `src/web/login/oidc-client.ts`. `RealWebLoginClient` is the only file that imports `openid-client`; routes and `requireAuth` depend on the interface, and route tests inject a `FakeWebLoginClient` (the repo's `SSHClient`/`AuthentikClient` injection pattern).

**Rationale**: discovery, PKCE, `state`/`nonce` checks, ID-token signature/issuer/audience/expiry validation, refresh, userinfo `sub` matching and end-session URL building are all security-critical and all provided. Hand-rolling them over `jose` would duplicate a well-reviewed library for no gain.

**Alternatives**: hand-rolled flow over `jose` (more code to get wrong); `passport-openidconnect` (callback-style, session middleware coupling, unmaintained-looking).

## R2. Which claims to trust, and when

**Decision**: at sign-in, validate the ID token, then call userinfo with the access token (`expectedSubject` = ID-token `sub`) and build the identity from userinfo, falling back to ID-token claims for any field userinfo omits. At every re-check (R4), the refresh grant's new access token is used for userinfo the same way. `username` = `preferred_username` (required; sign-in fails without it), `uid` = `sub`, `email` = `email`, `groups` = `groups` (array of names; absent = `[]`).

**Rationale**: the live instance has `include_claims_in_id_token = true` on every provider, so the ID token already carries `groups`; userinfo makes the result independent of that per-provider switch and is what re-checks must use anyway (a refreshed ID token is optional in OIDC). One code path for sign-in and re-check.

**Evidence**: live discovery document (captured 2026-10-05, redacted to `test/fixtures/authentik/oidc-discovery.json`) lists `groups`, `preferred_username`, `email` in `claims_supported`, `S256` in `code_challenge_methods_supported`, `refresh_token` in `grant_types_supported`, and an `end_session_endpoint` per application. Live provider settings (read via API): access code 1 minute, access token 1 hour, refresh token 30 days, claims in ID token on, client type confidential.

## R3. Session storage

**Decision**: a new SQLite database `data/sessions.sqlite3` (better-sqlite3, WAL, same `openDb` style as `jobs.sqlite3`), owned by `SessionStore` in `src/web/login/session-store.ts`. Tables `sessions` and `login_attempts` (data-model.md). The cookie value is 32 random bytes, base64url; the row key is its SHA-256 hex. `SessionStore` accepts `':memory:'` for tests.

**Rationale**: survives restart (FR-013); a separate file keeps auth state out of `inventory/bellhop.db` (whose full-replace writer must never see it) and out of `jobs.sqlite3` (different lifecycle). A hashed id means a leaked database copy cannot be replayed as a cookie. An opaque random id needs no signing key; "signed cookie" in the issue is satisfied by unguessability plus server-side lookup, and avoids a second secret to manage.

**Alternatives**: signed stateless cookie (cannot be revoked on sign-out or refusal; groups and tokens would bloat the cookie and expose the refresh token to the browser); storing in `bellhop.db` (mixes auth state with inventory and the settings store).

## R4. Re-checking with the refresh token

**Decision**: `requireAuth` (and the WebSocket upgrade) call `SessionStore`/`SessionService.resolve(cookie)`. If `now - lastCheckedAt >= 5 min`, it runs one refresh grant with the stored refresh token, then userinfo, and on success replaces username/email/groups/refresh token/ID token and `lastCheckedAt`. Outcomes:

- provider refuses (OAuth `invalid_grant`, `invalid_client`, HTTP 400/401 from the token endpoint, userinfo 401, `sub` mismatch) → delete the session, request is unauthenticated;
- network/5xx/timeout failure → keep the last-known identity, `logWarn` (naming the issuer, never a token), and try again on the next request after at least 1 minute (`lastAttemptAt`);
- session older than 30 days → delete, unauthenticated.

Re-checks are single-flighted per session hash with an in-process `Map<hash, Promise>`.

**Rationale**: Authentik rotates refresh tokens on use, so a second concurrent refresh with the consumed token would get `invalid_grant` and wrongly kill the session. One service process owns the store, so an in-process map suffices (multi-instance is out of scope). Keeping the session through an outage avoids signing everyone out on a blip; the bound on staleness during an outage is the outage's length, which the operator controls.

**Alternatives**: background timer refreshing all sessions (refreshes idle sessions for nothing, and keeps refresh tokens alive indefinitely); re-check on every request (an Authentik round trip per API call).

## R5. Pending sign-ins

**Decision**: `/auth/login` creates a `login_attempts` row (state, PKCE verifier, nonce, return path, created time) keyed by SHA-256 of a random attempt id, and sets cookie `bellhop_login` (HttpOnly, Secure, SameSite=Lax, Path=/auth, Max-Age 600). `/auth/callback` requires that cookie, loads and deletes the row in one transaction (single use), rejects rows older than 10 minutes, and passes the stored `state`/`nonce`/verifier to the code exchange.

**Rationale**: binds the callback to the browser that started it (login CSRF protection), survives a restart mid-login, single use. `SameSite=Lax` cookies are sent on Authentik's top-level GET redirect back.

## R6. Request authentication order

**Decision**: `resolveRequestUser(req)`:
1. a valid session cookie → session identity (`viaOidc: true`) — in either mode;
2. `WEB_UI_DEV_USER` → dev identity;
3. mode `none` → local operator;
4. otherwise unauthenticated: `/api/*` → 401 JSON; any other GET/HEAD → 302 `/auth/login?returnTo=<path+query>`; other methods → 401.

`/auth/*` is mounted before `requireAuth`. `X-authentik-*` headers are never read.

**Rationale**: honoring a session in `none` mode is what lets the operator sign in and prove an admin identity before switching to `oidc` (the lockout guard, R9), and it shows them as themselves. The dev user now outranks the local operator in `none` mode so the test suite's global `WEB_UI_DEV_USER=test-user` keeps working with the new `none` default; it is dev/test-only either way.

## R7. Discovery and configuration changes at runtime

**Decision**: `RealWebLoginClient` discovers lazily and caches the `openid-client` `Configuration` keyed by `(issuer, clientId, clientSecret)`; a settings change produces a new key and a fresh discovery. A failed discovery is not cached. OIDC settings are read through `configValue()` per request like every other setting.

## R8. Cookies

**Decision**: parse the `Cookie` header with a ~10-line helper in `src/web/login/cookies.ts` (shared by Express and the raw WebSocket upgrade); set/clear with Express's `res.cookie`/`res.clearCookie`. Session cookie: `bellhop_session`, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 30 days. No new dependency.

## R9. Settings-page lockout guard

**Decision**: replace the `authentik`-mode guard in `src/web/routes/settings.ts`. A PATCH setting `webUiAuthMode: 'oidc'` (from a different effective mode) is refused with 409 unless (a) the four OIDC settings are all set after this PATCH, and (b) `req.realUser ?? req.user` has `viaOidc` and passes `isAdminOf` under the post-save admin groups. Three distinct messages. The client's "leaving authentik" confirm becomes "leaving oidc". `forwardAuthIdentity` is deleted.

## R10. Mode values and migration

**Decision**: `WEB_UI_AUTH_MODES = ['oidc', 'none']`. `authMode()` returns `'none'` when unset. An env value of `auto`/`authentik` throws `WEB_UI_AUTH_MODE=<v> is no longer supported -- use oidc (sign-in required) or none (no authentication); see docs/authentik.md`. A one-time migration in `openInventoryDb` (beside `migrateCaddyToProxy`) rewrites `meta.webUiAuthMode` `authentik` → `oidc` and deletes `auto`, logging what changed; idempotent.

## R11. New settings and `configure-web-login`

**Decision**: settings `webUiOidcIssuer`, `webUiOidcClientId`, `webUiOidcRedirectUri` (non-secret, `httpUrl`/`nonEmpty`), secret `webUiOidcClientSecret` (`token` rule), env `WEB_UI_OIDC_ISSUER`, `WEB_UI_OIDC_CLIENT_ID`, `WEB_UI_OIDC_REDIRECT_URI`, `WEB_UI_OIDC_CLIENT_SECRET`, group `general` (shown on the General tab next to the mode), `envFile: 'authentik.env'`. CLI-only command `configure-web-login <entry> [--apply]` in `src/commands/networking/configure-web-login.ts`: `runOidcCredentials(entry)` for issuer/client id/secret, the entry's `oidcRedirectUris` entry whose URL path is exactly `/auth/callback` (error if none), then the same writers `set-config` uses (non-secrets through the settings write path, the secret through `writeSecret`). Dry run prints the three non-secret values and `webUiOidcClientSecret: (would be set)`.

**Rationale**: one step after `sync-authentik --apply`; no secret copied by hand (SC-006). CLI-only, so Principle IV's one-`Operation` rule does not apply; the first-run walkthrough (#70) can lift it into `src/operations/` when it needs it.

## R12. Firewall and proxy IP

**Decision**: `scripts/windows-service.ts` drops `remoteip=` and `resolveProxyIp`; the rule allows the port from any address. The Settings API's `derived.proxy` ("Proxy IP (firewall scope)") is removed with its UI line, as nothing else uses it. Proxy drivers are unchanged: they still strip `X-authentik-*` for forward-gated apps, which no longer matters to Bellhop itself.

## R13. Logout

**Decision**: `POST /auth/logout` (a form button in the Sidebar, not a link, so link prefetchers and cross-site GETs cannot sign a user out). It deletes the session, clears the cookie, and 303-redirects to the provider's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri` = origin of the redirect URI + `/auth/signed-out` when discovery advertises one; otherwise to `/auth/signed-out`. `GET /auth/signed-out` is a small static page with a "Sign in again" link. A failed discovery at logout still clears locally.

## R14. Tests and demo

**Decision**:

- `test/support/web-session.ts` exports `newTestSessions()` (an in-memory `SessionStore`) and `sessionCookie(store, user)`, which inserts a fresh session and returns the `Cookie` header value. Web tests pass `sessions` in `buildApp` deps and `.set('Cookie', ...)` instead of `x-authentik-*` headers. `buildApp`'s `sessions` dep is optional and defaults to a fresh in-memory store, so tests that use only `WEB_UI_DEV_USER` need no change.
- `RealWebLoginClient` is tested against an in-process fake provider (Express on 127.0.0.1 serving the captured discovery document with its endpoints rewritten to the local origin, a JWKS for an RSA key generated per test run, and token/userinfo endpoints), with `allowInsecureRequests` enabled only through a constructor option the tests pass. This exercises real signature, issuer, audience, nonce and PKCE validation, refresh rotation, and refusal handling.
- The demo seeds an admin session in its own in-memory store and injects that cookie (replacing `DEMO_IDENTITY_HEADERS`), and stores example OIDC settings (`https://authentik.example.com/application/o/bellhop/`, `https://bellhop.example.com/auth/callback`) with mode `oidc`, so screenshots show a normal signed-in admin and populated settings.

## R15. Getting a refresh token from Authentik

**Decision**: Bellhop requests `openid profile email offline_access`, and `sync-authentik`'s `OIDC_SCOPE_MAPPINGS` gains `goauthentik.io/providers/oauth2/scope-offline_access`. A sign-in whose token response has no refresh token fails with a page and log line naming the missing `offline_access` scope mapping and the fix (`sync-authentik --apply`).

**Rationale**: Authentik issues a refresh token only when the client requests `offline_access` and the provider has that scope mapping attached. The live discovery document lists only `email`, `openid`, `profile` in `scopes_supported`, matching the three mappings `sync-authentik` attaches today. The mapping exists on the instance (`test/fixtures/authentik/propertymappings-scope.json`, captured). `sync-authentik`'s existing scope-coverage reconcile (it appends a desired mapping whose scope an existing provider does not cover) attaches it to every Bellhop-owned OIDC provider on the next `--apply`. That is harmless for the other apps: a scope only applies when a client requests it. `OIDC_GRANT_TYPES` already includes `refresh_token`.

**Alternatives**: attaching it only to Bellhop's own provider (sync-authentik has no notion of which entry is Bellhop; adding one is more surface than the harmless global change); failing sign-in on no refresh token is preferred over silently accepting a session that can never be re-checked.

## R16. Live verification (cannot be automated)

A real Authentik sign-in, refresh rotation, group change within 5 minutes, deactivation sign-out, end-session redirect, the WebSocket stream behind the real proxy, and the upgrade sequence on the deployment checkout (quickstart.md) are verified by hand and recorded in the PR.
