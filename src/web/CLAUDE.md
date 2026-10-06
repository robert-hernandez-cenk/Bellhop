# Web service

The Express service under `src/web/`: auth, permissions, impersonation, guest-edit rules, push-live, Settings API.

Elsewhere: jobs/prompt relay/attribution in `src/web/jobs/CLAUDE.md`; scheduler and `routes/tasks.ts` in `src/web/tasks/CLAUDE.md`; `routes/oidc.ts` in `src/commands/networking/CLAUDE.md`; `previewAndEnqueue` in `src/operations/CLAUDE.md`; browser side in `web-client/CLAUDE.md`; authz rigor in root `CLAUDE.md`.

## Web UI authentication

Bellhop is its own OIDC client (#69): `GET /auth/login` starts an authorization-code + PKCE sign-in with Authentik, `GET /auth/callback` finishes it and creates a session, `POST /auth/logout` ends it. `X-authentik-*` request headers are never read (FR-018); any client can send one.

Files: `src/web/routes/auth.ts` (the `/auth` router: server-rendered pages, no client bundle; `safeReturnTo` keeps the post-login redirect same-origin), `src/web/login/` (`config.ts` `webLoginConfig()` reads the four `webUiOidc*` settings per call, never cached; `oidc-client.ts` `WebLoginClient`/`RealWebLoginClient`, scope `openid profile email offline_access`; `session-store.ts` `SessionStore`; `sessions.ts` `SessionService`; `cookies.ts`), `src/web/auth.ts` (`authMode`, `resolveRequestUser`, `requireAuth`). `buildApp` mounts `/auth` *before* `requireAuth`, so signing in needs no session.

- **Session store**: `data/sessions.sqlite3` (`server.ts` opens it; its own file so the inventory's full-replace writer never touches it). The browser holds only an opaque random id in the `bellhop_session` cookie (HttpOnly, `Secure`, Lax, 30 days); the row key is the id's SHA-256 (`hashId`). The row holds username/uid/email/groups plus the refresh and ID tokens. Pending sign-ins (`login_attempts`: state, nonce, PKCE verifier, `returnTo`) live there too, tied to the browser by a short-lived cookie scoped to `/auth`, valid 10 minutes, named per attempt after its OAuth state (`bellhop_login_<state>`, `loginCookieName`) so parallel sign-ins from several tabs don't overwrite each other; the callback finds its cookie by the `state` it arrives with. Each new attempt purges expired ones.
- **Re-check**: `SessionService.resolve` asks the provider again (refresh grant + userinfo) at most every `CHECK_INTERVAL_MS` (5 minutes), so a group change or deactivation lands within 5 minutes of the user's next request. `refused` (e.g. `invalid_grant`) deletes the session; `unreachable` keeps the last-known identity and retries after `CHECK_RETRY_MS` (1 minute), with one warning per attempt. Unconfigured web login at re-check time signs the session out; an invalid env-sourced `WEB_UI_OIDC_*` value is treated as unreachable (operator mistake, not a verdict). Authentik rotates the refresh token on use, so re-checks are single-flighted per session in the `inflight` map.
- `resolveRequestUser(headers, sessions)` is the one resolver (HTTP and WebSocket): a valid session cookie (honored in both modes, which is how an operator proves an admin sign-in before switching to `oidc`), else `WEB_UI_DEV_USER`, else the local operator in `none` mode, else `undefined`. `requireAuth` answers an unauthenticated `/api` call 401 JSON (the client turns that into a redirect to `/auth/login`), redirects a page GET/HEAD to `/auth/login?returnTo=...`, and 401s anything else.
- `AuthUser.uid` is the OIDC `sub` (stable; usernames get renamed), always set for a session identity, absent for dev/test identities and the local operator. `Actor` (`src/lib/pve-acl.ts`) gets it via `resolveActor` for `creatorFromActor`. `applyImpersonation` only replaces `groups` and sets `impersonating`, leaving `uid`; `isGuestCreator` keys off `impersonating`. Only `req.user.groups` may be overlaid after `requireAuth`; other fields and `req.realUser` stay the real identity.
- `AuthUser.viaOidc` is set only on a session identity (never dev user/local operator) and survives the impersonation overlay; the Settings guard reads it. It is not in `whoami`.

### webUiAuthMode

Setting `webUiAuthMode` (env `WEB_UI_AUTH_MODE` overrides), read per request by `authMode()` via the config accessor: `oidc` requires a session (401/redirect without one); `none` (the default when unset) serves a request with no session as the synthetic always-admin local operator, so a fresh clone works before any provider exists. The retired values `auto`/`authentik` are rejected by the setting schema; as `WEB_UI_AUTH_MODE` they make `authMode()` throw at start-up naming the replacement; `openInventoryDb` migrates a stored one (`src/lib/CLAUDE.md`).

**Production must store `webUiAuthMode=oidc`**: under `none`, anyone who can reach the port is a full admin. Stored, deleting `data/authentik.env` keeps sign-in required.

Lockout guard: a Settings PATCH switching to `oidc` is refused unless sign-in is configured and the requester has a session and would still be admin (details under "PATCH validation and refusals"). CLI/MCP writes are unrestricted (host trust), the recovery path: `set-config webUiAuthMode none --apply`, or `WEB_UI_AUTH_MODE=none` (`docs/authentik.md`, "Locked out").

`WEB_UI_DEV_USER` simulates a specific non-admin group membership (the local operator can't). It applies in every mode, `oidc` included, so it must stay unset in production. `scripts/windows-service.ts`'s `buildService()` sets only `PORT`/`USERPROFILE`, so any other override reaches production only through the dotenv-loaded `data/*.env` files; never set `WEB_UI_DEV_USER` there. Tests that assert an unauthenticated outcome must delete it (`npm test` sets `WEB_UI_DEV_USER=test-user` globally).

### Admin predicate

`isAdminUser` (`src/web/auth.ts`) is the single admin predicate: membership in `authentikAdminGroup` or `authentikBuiltinAdminGroup` (env `AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`) via `authentikConfig()`, defaults `bellhop-admins`/`authentik Admins`; the built-in one guarantees admin access without an out-of-band group edit. Unrelated to `AUTHENTIK_GROUP_LADDER` (gated-entry tiers).

### WebSocket path

`/ws/jobs/:id` (`src/web/routes/jobs.ts`) is on the raw `http.Server`, bypassing Express middleware, so its `'upgrade'` listener calls `resolveRequestUser` itself (it reads only the `Cookie` header, so the browser's session cookie authenticates the socket) and duplicates `applyImpersonation`'s overlay and the creator map inline (synced by hand; no shared helper until a third bypass exists). Otherwise the job-log socket would be unauthenticated.

### Firewall and HAProxy

Browsers now reach the service directly (the proxy no longer injects identity), so `scripts/windows-service.ts`'s `addFirewallRule` is not scoped to an address: no `remoteip=`, and `resolveProxyIp` is gone (`scripts/firewall-rule.ts`). The session cookie, not network position, is the boundary.

Bellhop's own route is not forward-gated, so the HAProxy driver serves it like any other backend: no `proxyManual` is needed (`docs/reverse-proxy/haproxy.md`, "Limits"). Bellhop's entry must be `authMode: oidc` with its `/auth/callback` URL in `oidcRedirectUris` (`sync-authentik`), and `configure-web-login` stores the client (`src/commands/networking/CLAUDE.md`).

### Single-operator assumptions

The session store and the re-check single-flighting assume one Bellhop service process: sessions live in one `data/sessions.sqlite3` and the `inflight` map and `ImpersonationStore` are in-process, so two instances would not share them (a rotated refresh token could sign a user out). Sign-in also assumes the service is reached over HTTPS under one origin (`Secure` cookie, one registered redirect URI).

## First-run setup (#86)

While `SetupService.phase()` is `pending` (a fresh install: no hosts, no `setup_state` row saying finished), `setupGate` (first middleware in `buildApp`) answers every `/api` and `/auth` request 503 `setupRequired`, redirects page loads to `/setup`, and refuses the job-log WebSocket; only `/api/setup/*` and static assets pass. `server.ts` creates the token (`ensurePendingSetup`) and logs the setup address on every start while pending. `GET /setup?token=` swaps a valid token for the `bellhop_setup` cookie (HttpOnly, SameSite=Strict, not Secure, since setup runs over plain HTTP before any TLS); `requireSetupAuth` compares it in constant time. `src/web/setup/proxmox.ts` holds step 1's actions (key install over a password `SshTarget`, test, host save + the `sync-inventory` apply, peers); its errors are fixed text so an ssh2 message can never echo the password. Finish sets `finished` and nulls the token; afterwards the gate is a no-op and `/api/setup/*` answers 404. The walkthrough has no CLI equivalent. See `docs/setup.md`.

Single-operator assumptions: one service process (the phase is cached in memory), and setup runs over plain HTTP, so the token and the one-time host password cross the network unencrypted unless the operator reaches Bellhop over a trusted network.

## MCP over HTTP

#65/#66. `src/web/mcp/` serves `buildMcpServer`'s tools over Streamable HTTP at `/mcp`, mounted by `buildApp` (via `buildMcpHttp`, `index.ts`) **ahead of `requireAuth`**: a session cookie never authenticates it, only `Authorization: Bearer`. Contract: `specs/065-mcp-https-transport/contracts/http-mcp.md`.

- **Checks** (`routes.ts`, in order, before any MCP handling): neither usable sign-in nor a valid `mcpApiKey` → `503` naming both fixes (an invalid `MCP_API_KEY` counts as no key and only warns, so it never blocks sign-in tokens); bad/missing bearer → `401` (+ `resource_metadata` while sign-in is on); signed-in caller no longer admin → `403`; then `McpHttpHost`.
- **Host** (`http-host.ts`): one `McpServer` + `StreamableHTTPServerTransport` per `Mcp-Session-Id`, created only by an `initialize` without a session id, bound to the caller's principal (`api-key` or `grant:<id>`); unknown id or another principal → `404` (so a re-authorized client re-initializes); the session's actor username follows each request's re-checked identity. Idle counts only from the end of its last POST (a running `wait_for_job` keeps it alive; the GET listening stream does not); idle 30 min → closed by an unref'd sweep. A POST whose response closes unfinished (client killed, no DELETE) has its requests cancelled as if the client sent `notifications/cancelled`, so an abandoned dialog releases the shared prompt claim. Tool descriptions say jobs outlive the client (`transport: 'http'`). Control requests from a session are labelled `mcp:http` with the caller's name (`Stop requested from MCP by <user>`). All sessions share the web `JobRunner` (jobs are `owner: 'web'`, outlive the client) and one `PromptTracker`.
- **API key** (`api-key.ts`): `mcpApiKey`/`MCP_API_KEY`, read per request, compared as SHA-256 digests with `timingSafeEqual`; principal and username `api-key`.
- **Authorization server**: the SDK's `mcpAuthRouter` (discovery, `/register`, `/authorize`, `/token`, `/revoke` — root paths the SDK fixes) with `BellhopOAuthProvider` (`oauth-provider.ts`). Issuer = origin of `webUiOidcRedirectUri`; the router is built on first use per issuer and cached (hence express-rate-limit's `creationStack` check is off; `xForwardedForHeader` too, since the app sets no `trust proxy`). Not mounted while sign-in is unconfigured or the issuer is neither https nor localhost/127.0.0.1.
- **Consent** (`consent.ts`): `/authorize` stores a pending request (`McpAuthStore`) and renders a page naming the client and its return origin; the pending id is bound to the browser by a per-request cookie (`bellhop_mcp_<hash prefix>`, path `/auth`, Lax). `POST /auth/mcp/consent`: deny → `access_denied` to the client; approve → restarts the pending 10 minutes, then `beginSignIn` (`routes/auth.ts`, shared with `/auth/login`) with the attempt carrying `mcpPendingHash`. Any MCP sign-in failure (start or callback) goes to `failSignIn`, which sends the client an OAuth error rather than a web-login page.
- **Callback**: an attempt with `mcpPendingHash` goes to `mcpSignInFinisher` instead of setting a cookie: non-admin → `403` page, nothing issued; admin → `SessionService.createDetached` (a session row whose raw id is discarded; only its hash is kept), a code, and a redirect to the client.
- **Tokens** (`auth-store.ts`, tables in `data/sessions.sqlite3`, every token-like value SHA-256'd): codes single use/10 min; access 1 h; refresh rotates on use; a grant ends with its session row (refused re-check, 30 days) or on revoke, which deletes that session row too; only never-used client registrations are purged (24 h). `verifyAccessToken` resolves access → grant → `SessionService.resolveHash` (the web re-check policy) → `isAdminUser`.
- Registered clients' own secrets are stored as registered: the SDK's client authentication compares them in plain text.

### Single-operator assumptions (MCP over HTTP)

MCP sessions and the shared `PromptTracker` are in-process, and the authorization server's issuer is the one origin of `webUiOidcRedirectUri` — the same one-service, one-origin assumptions as web sign-in. Behind the proxy every client shares one rate-limit bucket, and there is one shared `mcpApiKey` (rotating it reconfigures every headless client).

## Inventory reload

`inventory` loads once at startup (`src/web/server.ts`); a global middleware in `buildApp` (`src/web/app.ts`) calls `refreshInventory(deps.inventory, deps.inventoryPath)` per `/api` request, `Object.assign`ing a fresh `loadInventory` onto the *existing* object so route closures see DB/CLI edits without restart. A failed reload (e.g. lock) is `logWarn`ed; the last good copy is used. It also invalidates the config snapshot (`src/lib/CLAUDE.md`).

Gotcha: `inventory` is shared and mutable across `await`s (e.g. `syncProxyLive` in `src/web/proxy-sync.ts` across an SSH + Authentik round trip); snapshot it locally if a handler needs it constant.

## Users and groups

`src/web/routes/users.ts`, `groups.ts`: Authentik user/group CRUD behind `requireAdminGroup` (`isAdminUser` on `req.user.groups`) plus `requireUserDirectory` (`src/web/auth.ts`). No URL/token: "Running without Authentik" in `docs/authentik.md`.

- `GET /api/whoami` (`src/web/routes/dashboard.ts`) returns `isAdmin`, `adminGroups`, `capabilities` (incl. `userDirectory`); admin group names are defined once (`authentikConfig()`), the client reads them here.
- `POST /api/users` never takes a password: it returns an Authentik recovery link (also exposed standalone for a locked-out user).
- `DELETE /api/users/:id` and `POST /api/users/:id/deactivate` 400 on the requester's own account (self-lockout guard).

### AuthentikClient

`src/lib/authentik-client.ts` wraps REST v3 (`SSHClient` injection pattern): `RealAuthentikClient` when `authentikApiUrl` + secret `authentikApiToken` (or `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN`) are set (`authentikConfigured()`), else `UnconfiguredAuthentikClient`, failing every call with one "not configured" error. `buildAuthentikClient()` returns a `liveClient` re-deciding per call, so a once-built client (and `isConfigured()`, `requireUserDirectory`, `capabilities.userDirectory`) follows later saves. `data/authentik.env` is only a one-time import source and, while present, an override.

No live test (verify manually); `test/lib/authentik-client.test.ts` pins bodies/mapping via `withStubbedFetch`. Quirk (2026.8, live-verified): proxy providers subclass OAuth2Provider, so `GET /api/v3/providers/oauth2/` returns them too, with OAuth2 `meta_model_name`/`component`; only `GET /api/v3/providers/proxy/` membership tells them apart. `listOAuth2Providers()` drops those pks, so callers (`ownedProviderKind`, `planProviderName`, `adopt-oidc-client.ts`, `oidc-credentials.ts`) never re-check.

### web:dev admin caveat

`npm run web:dev` sets `WEB_UI_DEV_USER` and `WEB_UI_DEV_GROUPS=bellhop-admins` (`resolveRequestUser`'s dev fallback) so `/users` works without Authentik. That hardcodes the *default* admin group: if the effective `authentikAdminGroup`/`AUTHENTIK_ADMIN_GROUP` differs, the session is **not** admin (`canLower` is `false`; widening/clearing a tier refused). Fix by aligning that setting or `WEB_UI_DEV_GROUPS`.

## Per-resource permissions

`src/web/access.ts`, `src/web/routes/permissions.ts`, over pure `isAllowed` (`src/lib/permissions.ts`). Tables `permission_groups`/`permission_rules` (outside `saveInventory`'s replace; edited on the admin-only Permissions page) hold each group's mode (`allow-list`/`block-list`) and host/guest list; no `permission_groups` row = unrestricted.

- `isResourceAllowed`/`filterInventoryForUser` add an admin bypass (`isAdminUser`). Multi-group access is an intersection: the most restrictive group wins.
- Enforcement: read-filtering on `GET /api/inventory`, `GET /api/guests/status`; `requireResourceAccess` (middleware or inline) on every route mutating a specific host/guest: Dashboard guest PATCH, `guest-power`/`set-guest-vpn`, `update-app`, VPN gateway proxy routes, every provisioning `preview`/`apply`.
- Untargeted fleet actions (`update-all`, `audit-nfs-mounts`, `sync-ssh-keys`, `push-ssh-key`, `sync-inventory`, `sync-proxy`) stay `requireAdminGroup`.
- External sites: out of scope (not exposed in the web UI).
- Host and guest rules are independent: blocking a host hides only the host entry, not its guests.

### Job visibility (`isJobVisible`)

`GET /api/jobs(/:id)` and cancel/answer/dismiss-prompt filter in `src/web/routes/jobs.ts`. A job `target` (`src/web/jobs/job-store.ts`) is an untyped name, so `isJobVisible` matches rules by name alone rather than `isResourceAllowed` (needs a type). Never check it as host and guest and OR the results: a block rule tagged with the other type would leak, since a missing row under the untagged type defaults to allowed.

### Creator access

An allow-list-restricted user keeps access to a guest they created in the web UI (#58).

- `isGuestCreator(creator, caller)` (`src/lib/permissions.ts`): `false` while impersonating (no leak into an impersonated view) or with no `creator`; uid comparison when both have one, else username.
- `isAllowed`'s `opts.isCreator`: for `guest` refs only, allow-list groups treat the guest as listed; block-list unchanged (explicit block wins).
- `isResourceAllowed`/`filterInventoryForUser` take an `AccessCaller` (`groups`/`username`/`uid`/`impersonating` subset of `AuthUser`) and resolve the creator from the in-memory `Inventory`.
- `isJobVisible` takes the job row (`{ target, startedAt }`) and `creators: Map<guestName, GuestCreator>` (`guestCreators(inventory)`, taking `Pick<Inventory, 'guests' | 'hosts'>`, per request), lifting jobs on the caller's guests, with two limits:
  - `guestCreators` omits a guest named like a host: guest-creating commands record the *host* as target, so it would expose that host's jobs. (Not a `validateInventory` rule, which could make a saved inventory unloadable.)
  - Only jobs started at or after the creator's `since` (ISO-8601, `created_by_since`) are lifted, so a re-created reused name never exposes the old guest's jobs. No `since` or unstarted job: no lift (fail closed). Guest access never reads `since`.
- Writers: `recordProvisionedGuest` and `deploy-vpn-gateway`'s operation (`src/operations/provisioning.ts`) use `creatorFromActor(deps.actor, deps.now?.())`; `deps.actor` is the real never-impersonated person, `undefined` (no record) for MCP/CLI/local operator. `since` is that clock, or the creating job's `startedAt` for `backfill-guest-creators` (`src/commands/maintenance/CLAUDE.md`).
- Preservation: `upsertGuestEntry` keeps `creator` on a repeat apply without an actor, replaces it with one; `sync-inventory`'s merge and `migrate-guest` keep it; it goes with the guest row.
- Not editable: `applyGuestEdits` (`src/operations/edit-guest.ts`) copies named fields only; MCP `EDIT_GUEST_SHAPE` strips unknown keys. The Advanced modal shows "Created by" username, never the uid.

### Filtered inventory and used MIDs

`GET /api/inventory` is filtered, so nothing needing *every* guest may be computed from it in the browser (#54). The MID suggestion, migrate-guest's preferred-MID check, and the MID collision warning use `GET /api/provisioning/used-mids` (occupied MIDs per visible host, from the unfiltered inventory, no names); the warning names a guest only if visible. `checkVmidAvailable`'s optional `canSeeGuest` (`OperationDeps.canSeeGuest`, from `isResourceAllowed`) omits an invisible occupant's name; CLI/MCP pass none.

## Admin impersonation

`src/web/impersonation.ts`, `routes/impersonation.ts` (#101): an admin acts as if only in one non-admin group, to test its rules.

- In-memory `ImpersonationStore`, `Map<realUsername, groupName>` keyed by the real username of the signed-in session; no cookie/secret/disk; restart clears it.
- `applyImpersonation`, right after `requireAuth` in `app.ts`, overlays `req.user.groups` and stashes the real identity on `req.realUser`. All checks (`isResourceAllowed`, `requireResourceAccess`, `isJobVisible`, `requireAdminGroup`) read only `req.user.groups`, so this one overlay is the whole mechanism.
- `POST`/`DELETE /api/impersonate` (the only store writers) use `requireRealAdminGroup`, checking `(req.realUser ?? req.user).groups`; with `requireAdminGroup` an impersonating admin would 403 on turning it off, locked in until restart.
- The two admin groups are excluded from the picker and rejected server-side (no-op).
- `resolveTriggeredBy(req)` (`src/web/impersonation.ts`), the attribution helper, uses `req.realUser ?? req.user`, giving the real admin even while impersonating; `resolveActor(req)` follows the same rule but is `undefined` for the local operator.

## Dashboard guest edits

Handler: `src/web/routes/dashboard.ts`. Shared commit (`commitGuestEdit`, `editDeletesOidcClient`/`OIDC_CLIENT_DELETION_CONFIRMATION_ERROR`): `src/operations/CLAUDE.md`. Authentik reconcile: `src/commands/networking/CLAUDE.md`.

### authGroup raise/lower

Asymmetric, enforced in the handler via `isAdminUser` (same impersonation behavior): anyone with resource access may *raise* (narrower rung, or gating an ungated entry); only an admin may *lower* (broader rung, or clearing). `GET /api/auth-groups` (`src/web/routes/auth-groups.ts`) lists rungs; authenticated but not admin-gated, since non-admins need it to raise.

### unauthenticatedPaths add rule

Adding an exemption is privileged (only adding can expose something):

- Anyone with resource access may narrow: remove, clear, or reorder (compared as a set, so reordering isn't an addition).
- Adding to an entry whose *resulting* `authGroup` (after this request's own edit) is set requires reaching that app: admin, or member of that rung or above (`rungsAtOrAbove`); else 403.
- Unchecked with no `authGroup`: drivers only render exemptions for forward-gated routes, so nothing widens.

So a non-admin can exempt every path on an ungated entry, then gate it (a "raise"). Not an escalation (it was public), but a "raise" doesn't guarantee protection.

### OIDC field edits (`oidcEditChangeError`)

Changing `authMode`, `oidcRedirectUris`, or `oidcMobileRedirectUris` is admin-only both ways, no raise/lower exception: switching to OIDC drops the proxy's forward-auth gate, and a (web or mobile) callback URL decides where a login lands, so no such edit is purely narrowing. `oidcEditChangeError` fires when the body touches any of them, comparing *parsed* current vs. updated entries (order-sensitive), so resending an unchanged value isn't a change.

### Live TLS-backend probe

`probeInsecureBackendTls` (`src/lib/tls-probe.ts`; `src/lib/CLAUDE.md`) runs single-shot (no retries; edited guest presumed running), only when `subdomains`/`port` changed and the result isn't `proxyManual` (whose proxy config, and so `insecureBackendTls`, is never generated). Conclusive overwrites the request's `insecureBackendTls`; inconclusive leaves the submitted/stored value. Never throws.

## Push-live step (`syncProxyLive`)

`src/web/proxy-sync.ts`'s `syncProxyLive` runs `sync-proxy`, `render-status-page`, `sync-authentik`, `prune-acme-challenges` as one step, triggered by every Dashboard subdomain/`authGroup`/OIDC edit and provisioning applies with subdomains, so an OIDC client changes in the same request.

- If `sync-proxy` throws (failed write/validate, or an Nginx Proxy Manager route conflicting every sync): warn, skip `render-status-page`/`prune-acme-challenges`, still run `sync-authentik` (its error only warned), then rethrow the proxy error (operator decision). So one lasting proxy conflict never blocks Authentik reconcile, and callers still report it (`proxySynced: false`/`proxyError`, a failed provisioning job). All drivers; CLI `sync-proxy` unchanged.
- Proxy config is written *before* Authentik sync: switching to OIDC drops `forward_auth` first, so a skipped/failed Authentik sync leaves the app ungated at the edge until the next success.
- Returns `authentikConflicts`, `authentikAdoptableConflicts`, `authentikOidcSkipped`, `authentikForwardSkipped`, OIDC discovery failures, `authentikMobileConsentProblems`; `commitGuestEdit` narrows them to the edited guest. The PATCH runs outside a job, so returning them (not `logWarn` to stderr) is how they reach the user. Status-page/prune skips: `src/commands/networking/CLAUDE.md`.

## Provisioning routes: inventory upsert

`src/web/routes/provisioning.ts`. CLI `create-lxc`/`create-vm`/`install-app` never touch `inventory/bellhop.db`; the route layer does (commands stay inventory-agnostic). On success `recordProvisionedGuest` upserts the guest at once (name/type/vmid/host/ip from the MID, plus form `subdomains`); with `subdomains` it awaits `syncProxyLive` in the same job, so apply succeeds only once they're live.

With `ip` + `port` + non-empty `subdomains` it runs the TLS probe, ~3-minute budget (6 retries, 30s apart, a job-log line each). In practice only `install-app` (the other forms collect no `port`; those guests are probed when a Dashboard edit first sets `port` + `subdomains`). Conclusive overwrites the submitted `insecureBackendTls`. The CLI has no hook: manual.

The router's `deps()` sets `actor` (`resolveActor(req)`) and `canSeeGuest`.

## App updates route

`GET /api/app-updates` (`src/web/routes/app-updates.ts`) returns `app_update_status` rows minus any whose guest is no longer an eligible `lxc` + `app` guest, whose stored `app` differs from the guest's (repurposed guest), or that the caller can't see (one `filterInventoryForUser` per request; no admin gate). The check: `src/commands/maintenance/CLAUDE.md`.

## Settings page (API)

`GET`/`PATCH /api/settings` (`src/web/routes/settings.ts`), `requireAdminGroup` (non-admins and impersonating admins get 403). Unlike Users/Permissions it needs no Authentik user directory, only an identity. Storage/secrets: `src/lib/CLAUDE.md` (Settings store); UI: `web-client/CLAUDE.md` (Settings page).

### settingsResponse()

Shared by GET and PATCH so they never disagree:

- `settings`: only *stored* non-secret values (what inputs edit).
- `proxyDrivers`: `listDrivers()` in registration order, each `{ id, label, defaultConfigPath, suggestedStatusPagePath, managesProxy, tlsSources, defaultTlsSource, usesCertResolver, usesApiUrl, usesNpmApi, configPathNote }` (`proxyDriversInfo()`; `tlsSources`/`defaultTlsSource` from `capabilities`, #72; `uses*` default `false`).
- `defaultProxyDriver` (`DEFAULT_PROXY_DRIVER_ID`), `acmeDnsProviders` (`[...ACME_DNS_PROVIDERS]`), `defaultAcmeDnsProvider` (`DEFAULT_ACME_DNS_PROVIDER`). PATCH validates `tlsSource`/`acmeDnsProvider` by schema only, with no check against the active driver; `proxyCaddyTls` is rejected as an unknown key.
- `sources`: each non-secret key's `environment`/`settings`/`none`.
- `environment`: only env-pinned keys, `{ variable, value?, stored, storedValue? }`; `value` is the effective non-secret value, never present for a secret; `stored`/`storedValue` drive the "Stored copy" line operators check before deleting a `data/*.env` file.
- `secrets`: `{ set, source }` per secret, never the value.
- `derived` (`derivedValues()`): read-only resolved values: each host's `midScheme.gateway`, (`derived.proxy` is gone: nothing is address-scoped any more).

### PATCH validation and refusals

Non-secrets validate against exported `SettingsSchema` (shared with `set-config`, so both reject identically); `null`/`''` clears like `--unset`. Secrets: string sets via `writeSecret`, `null`/`''` clears via `clearSecret`. Before writing anything, refuses:

- an env-pinned key: 400 naming the variable and its `data/*.env` file, telling the operator to unset it *and restart the service* (the CLI stores and warns instead, its environment not necessarily the service's);
- an admin-group change under which the real requester (`req.realUser ?? req.user`; never blocks the local operator) would fail `isAdminUser` (`adminGroupsWith`, `src/lib/authentik-config.ts`): 409;
- `webUiAuthMode: 'oidc'` (when not already in force): 409 unless, in order, all four `webUiOidc*` values are set after the PATCH (same-request values and env overrides count) and the real requester (`realUser ?? user`) has a session (`viaOidc`), then the real requester is an admin under the post-save admin groups (409 "...who would not be an admin after this change"; needed because `requireAdminGroup` judges the impersonation overlay and the lockout guard only runs on admin-group changes). Success logs `webUiAuthMode set to oidc by <user>`. While `oidc` stays in force, a PATCH that clears any `webUiOidc*` value (secret included) is 409 "Refusing to clear ... while webUiAuthMode is oidc"; changing a value is allowed, and only keys the request itself clears count, so an unrelated save is never refused. The CLI's `set-config` is unrestricted.
