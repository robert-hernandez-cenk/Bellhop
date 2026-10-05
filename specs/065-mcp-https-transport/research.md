# Research: MCP over HTTPS with sign-in and an API-key fallback

Decisions taken while planning #65/#66. Each says what was chosen, why, and what else was considered.

## R1. Where the HTTP transport runs

- **Decision**: mount it on the existing web service (`buildApp`), at `/mcp`, ahead of the cookie-based `requireAuth`. TLS terminates at the operator's reverse proxy, which already serves Bellhop's own subdomain.
- **Rationale**: the user's choice in brainstorming ("the route hangs off the current subdomain"). No new process, port or certificate settings; jobs are owned by the long-running `web` runner, so they survive a client disconnecting, show up in the web UI, and `wait_for_job` (owner-only) works for every HTTP-started job.
- **Alternatives**: `npm run mcp -- --http` with its own HTTPS listener (needs cert/key settings and a trusted certificate on every client, a second always-on process, and its own job-ownership/shutdown rules) — rejected.

## R2. Authorization server: the SDK's `mcpAuthRouter`

- **Decision**: Bellhop is the OAuth authorization server for `/mcp`, built from `@modelcontextprotocol/sdk` 1.30's `mcpAuthRouter` (discovery documents, dynamic client registration, `/authorize`, `/token`, `/revoke`) and `requireBearerAuth`, with a Bellhop `OAuthServerProvider`. The SDK validates PKCE (S256 only), client authentication, redirect-URI matching (exact, loopback any port per RFC 8252) and the token request shapes.
- **Issuer**: the origin of the configured `webUiOidcRedirectUri` (FR-015) — e.g. `https://bellhop.example.com/`; the protected resource is `<origin>/mcp`. The SDK refuses a non-HTTPS issuer except `localhost`/`127.0.0.1`, which matches the web login's loopback-only `http://` rule (an `http://[::1]` redirect URI is the one combination where MCP sign-in is unavailable and only the key works; documented).
- **Settings change without restart**: the router is built lazily per request from the current issuer and cached by issuer `href`, so changing the web-login settings applies on the next request.
- **Paths**: the SDK fixes the endpoints at the root (`/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`); `createOAuthMetadata` resolves them as absolute paths, so `baseUrl` cannot namespace them. They are mounted before `requireAuth` and the SPA fallback, and become reserved paths (no client route uses them).
- **Rate limits**: the SDK's per-endpoint limits stay on. Behind the proxy every client shares the proxy's address; at single-operator volume that is harmless, and it still caps anonymous `/register` floods. Its `X-Forwarded-For` validation warning is turned off (the app does not set `trust proxy`).
- **Alternatives**: Authentik as the authorization server directly — it does not support dynamic client registration, which MCP clients rely on; per-client manual setup in Authentik was rejected as the opposite of "login with the tool". A hand-written OAuth server — rejected, the SDK's is maintained and tested against real clients.

## R3. Whose identity a token carries, and how it stays current

- **Decision**: approving consent runs a **fresh** sign-in with Bellhop's Authentik web-login client (the same `/auth/callback`), which creates a dedicated row in the existing `sessions` table that no browser cookie points to. The grant references that row **by its id hash**; the raw id is discarded immediately. Each `/mcp` request resolves the identity through `SessionService` (the same 5-minute re-check, refused → gone, unreachable → last-known), keyed by hash.
- **Rationale**: reuses #69's re-check policy and single-flighting verbatim, so MCP access follows Authentik group changes and deactivation exactly like the web UI (FR-012), and is independent of browser sign-out (FR-010). Keeping only the hash means a leaked `sessions.sqlite3` still cannot be replayed as a `bellhop_session` cookie.
- **Consequence**: `SessionStore`/`SessionService` gain hash-keyed lookups (`getSessionByHash`, `resolveHash`); the cookie-keyed methods become thin wrappers.
- **Admin rule**: checked with `isAdminUser` at the callback (non-admin → explanatory page, no code, the dedicated session is deleted) and on every request (no longer admin → `InsufficientScopeError` → 403; FR-011/FR-012).
- **Alternatives**: issue tokens off the browser's existing cookie session (signing out of the web UI would kill MCP; cannot rotate the provider refresh token for two consumers); a long-lived Bellhop token with no provider re-check (a demoted admin keeps access) — both rejected.

## R4. Consent page and CSRF

- **Decision**: `provider.authorize` stores a pending authorization (client, redirect URI, PKCE challenge, state, scopes, resource; 10 minutes) and renders a small server-side consent page (same style as `/auth` pages, every value `escapeHtml`ed) naming the client (`client_name`, else its id) and the redirect URI's origin. The page posts to `POST /auth/mcp/consent`. The pending id is bound to the browser by a cookie named per pending id (path `/auth`, `HttpOnly`, `SameSite=Lax`, `Secure` except loopback), so a cross-site form post cannot approve a pending request planted by someone else. Deny → redirect to the client with `error=access_denied`. Approve → start the Authentik sign-in as `/auth/login` does, with the attempt carrying the pending id; the callback branches on it.
- **Rationale**: dynamic registration lets anyone register any redirect URI; without consent a crafted link could silently deliver a code for the operator's identity to an attacker's redirect. Showing the return address lets the person spot it.

## R5. Tokens

- **Decision**: opaque random 32-byte base64url strings, stored as SHA-256 hashes in `data/sessions.sqlite3`. Access token 1 hour. Refresh token rotates on every use (old one invalid immediately); the grant ends with its session row (30 days after sign-in). Authorization codes single use, 10 minutes, bound to client, redirect URI, PKCE challenge and resource. Revocation of a refresh token deletes the grant and its access tokens; of an access token deletes that token.
- **Client registrations** are stored as the SDK returns them (`OAuthClientInformationFull` JSON). The SDK's client authentication compares `client_secret` in plain text, so registered client secrets cannot be hashed; a client secret alone grants nothing without a grant's refresh token. Spec FR-014 is narrowed accordingly. Registrations never used for a grant are purged 24 hours after registration (on each new registration).

## R6. API key

- **Decision**: new secret `mcpApiKey` in `SecretSettingsSchema`/`SETTING_DEFS` (env `MCP_API_KEY`, group `mcp`, no `envFile`), validated as a token (no whitespace) of at least 32 characters. `verifyAccessToken` checks it first: SHA-256 both sides and `timingSafeEqual` (equal-length digests, so no length leak). A match yields principal `api-key`.
- **Generate**: Settings page button fills the masked input with 32 random bytes from `crypto.getRandomValues`, base64url-encoded, and reveals it in that input until saved, so the server never returns a secret (FR-018). `set-config mcpApiKey --stdin --apply` covers the CLI through the existing secret path; MCP `set_config` excludes secrets automatically.
- **Where it shows**: a new **MCP** Settings tab (`SettingGroup` `mcp`) holding the key, with help text giving the endpoint URL shape and pointing to `docs/mcp-server.md`.

## R7. Fail closed

- **Decision**: a guard in front of `/mcp` answers `503` JSON naming both fixes (`bellhop configure-web-login <entry> --apply`, or set `mcpApiKey`) when neither sign-in nor a key is configured. When only the key is configured, the OAuth routes are not mounted (discovery 404) and the bearer 401 carries no `resource_metadata`. The rest of the web service is unaffected (FR-020).

## R8. MCP HTTP sessions

- **Decision**: stateful `StreamableHTTPServerTransport` (`sessionIdGenerator: randomUUID`). A map `sessionId → { transport, server, principal, lastSeen }`; a new session is created only by an `initialize` request without a session id, with a fresh `buildMcpServer`. Each request's principal (`api-key`, or `grant:<id>` for sign-in) must equal the session's, else 403. An unref'd sweep every minute closes sessions idle 30 minutes; a client `DELETE` or transport close removes it. Unknown session id → 404 (the SDK's convention, which makes clients re-initialize).
- **Shared state**: one `PromptTracker` for all HTTP sessions (it is server-agnostic), passed to `buildMcpServer` through a new option, so two sessions never both open a dialog for one prompt (FR-005). The per-session `ping()` workaround already runs per `McpServer`.

## R9. Attribution

- **Decision**: `jobs.triggered_via TEXT` (nullable; `ensureColumn` migration), `JobDefinition.triggeredVia?: 'web' | 'mcp'`. `resolveTriggeredBy` (every web route's attribution) adds `triggeredVia: 'web'`; the scheduler's own daily run keeps username `scheduler` and no front end (it is not a front end; spec FR-021 narrowed). `buildMcpServer` takes an `actor { username }` option: HTTP sign-in → the session's username, key → `api-key`, stdio → `os.userInfo().username`; all with `triggeredVia: 'mcp'`. `summarizeJob` and the web job list/detail show it.
- **`backfill-guest-creators`**: today it skips `triggeredByUsername === 'mcp'` because MCP never records a creator. MCP jobs now carry real usernames, so the rule becomes "skip `triggeredVia === 'mcp'` or username `mcp`" (old rows), keeping its meaning.

## R10. Testing approach

- Route/flow tests drive the real `buildApp` on `127.0.0.1:0` with `fetch`, a `FakeWebLoginClient` and an injected web-login config with redirect URI `http://localhost:<port>/auth/callback` (loopback issuer allowed by the SDK).
- MCP calls use the SDK's own `Client` + `StreamableHTTPClientTransport` with an `Authorization` header, so the transport is exercised exactly as real clients use it.
- Token/code expiry uses an injected clock on the new store.
- Real-client verification (Claude Code against the deployed service through the proxy) is manual and recorded in the PR, like other real network paths.
