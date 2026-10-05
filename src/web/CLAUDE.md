# Web service

The Express service under `src/web/`: auth, permissions, impersonation, guest-edit rules, push-live, Settings API.

Elsewhere: jobs/prompt relay/attribution in `src/web/jobs/CLAUDE.md`; scheduler and `routes/tasks.ts` in `src/web/tasks/CLAUDE.md`; `routes/oidc.ts` in `src/commands/networking/CLAUDE.md`; `previewAndEnqueue` in `src/operations/CLAUDE.md`; browser side in `web-client/CLAUDE.md`; authz rigor in root `CLAUDE.md`.

## Web UI authentication

`src/web/auth.ts`. Global `requireAuth`, mounted in `src/web/app.ts` ahead of every route, trusts the `X-authentik-*` headers the `proxy: true` entry's proxy adds after checking Authentik (Caddy `forward_auth`, nginx `auth_request`). No OIDC client, login page, or session store here: Authentik and the proxy own the session (chosen over an app-embedded OIDC client); the app only reads verified headers (`resolveAuthUser`, exported for the WebSocket path).

- Only `req.user.groups` may be overlaid (by impersonation) after `requireAuth`; other `req.user` fields and `req.realUser` stay the real identity.
- `resolveAuthUser` reads non-empty `x-authentik-uid` into `AuthUser.uid` (stable; usernames get renamed). Absent for dev/test identities and the local operator. `Actor` (`src/lib/pve-acl.ts`) gets it via `resolveActor` for `creatorFromActor`. `applyImpersonation` only replaces `groups` and sets `impersonating`, leaving `uid`; `isGuestCreator` keys off `impersonating`.

### webUiAuthMode

Setting `webUiAuthMode` (env `WEB_UI_AUTH_MODE` overrides), read per request by `authMode()` via the config accessor: `auto` (default) falls back to a synthetic always-admin local operator without trusted headers; `authentik` requires them (401 otherwise); `none` ignores headers.

**Production must store `webUiAuthMode=authentik`** (or pin the env var): under `auto`, a proxy config that lost forward-auth serves everyone as full-admin instead of failing closed. Stored, deleting `data/authentik.env` keeps sign-in required.

Lockout guards (web-editable setting):

- `AuthUser.viaForwardAuth` is set only on the `x-authentik-username` branch (never dev user/local operator) and survives the impersonation overlay.
- A Settings PATCH setting `authentik` re-parses the request's headers with `forwardAuthIdentity` (regardless of mode; in `none` mode `req.user` is the local operator even with headers) and refuses (409) unless they name a user passing `isAdminOf` under the admin groups that PATCH leaves. The server `logWarn`s who left `authentik`; the page confirms first.
- CLI/MCP writes are unrestricted (host trust), the recovery path: `set-config webUiAuthMode auto --apply`, or the env var (`docs/authentik.md`, "Locked out").

`WEB_UI_DEV_USER` simulates a specific non-admin group membership (the local operator can't). It applies in every mode, even `authentik`, so it must stay unset in production. `scripts/windows-service.ts`'s `buildService()` sets only `PORT`/`USERPROFILE`, so any other override reaches production only through the dotenv-loaded `data/*.env` files; never set `WEB_UI_DEV_USER` there.

### Admin predicate

`isAdminUser` (`src/web/auth.ts`) is the single admin predicate: membership in `authentikAdminGroup` or `authentikBuiltinAdminGroup` (env `AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`) via `authentikConfig()`, defaults `bellhop-admins`/`authentik Admins`; the built-in one guarantees admin access without an out-of-band group edit. Unrelated to `AUTHENTIK_GROUP_LADDER` (gated-entry tiers).

### WebSocket path

`/ws/jobs/:id` (`src/web/routes/jobs.ts`) is on the raw `http.Server`, bypassing Express middleware, so its `'upgrade'` listener calls `resolveAuthUser` itself and duplicates `applyImpersonation`'s overlay and the creator map inline (synced by hand; no shared helper until a third bypass exists). Otherwise the job-log socket would be unauthenticated.

### Firewall scope and HAProxy

None of this is safe alone: it relies on `scripts/windows-service.ts`'s `addFirewallRule` scoping to `remoteip=<proxy host's IP>`, so only the proxy can reach the app and nothing can spoof the headers. `resolveProxyIp` derives it from `findProxyEntry`/`proxy: true` (errors name `'proxy: true'`), so it follows the entry, not the driver.

HAProxy can't forward-gate and its Bellhop backends strip `X-authentik-*`, so serving the web UI through one under `authentik` mode only 401s. Instead mark that entry `proxyManual` and hand-author its routing with Authentik forward-auth (e.g. community Lua) that overwrites, never passes through, `X-authentik-*`; production keeps `authentik` ("Limits", `docs/reverse-proxy/haproxy.md`).

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

`npm run web:dev` sets `WEB_UI_DEV_USER` and `WEB_UI_DEV_GROUPS=bellhop-admins` (`resolveAuthUser`'s dev fallback) so `/users` works without Authentik. That hardcodes the *default* admin group: if the effective `authentikAdminGroup`/`AUTHENTIK_ADMIN_GROUP` differs, the session is **not** admin (`canLower` is `false`; widening/clearing a tier refused). Fix by aligning that setting or `WEB_UI_DEV_GROUPS`.

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

- In-memory `ImpersonationStore`, `Map<realUsername, groupName>` keyed by trusted `X-authentik-username`; no cookie/secret/disk; restart clears it.
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
- `proxyDrivers`: `listDrivers()` in registration order, each `{ id, label, defaultConfigPath, suggestedStatusPagePath, managesProxy, usesSharedCertificate, usesCertResolver, usesApiUrl, usesCaddyTls, usesNpmApi, configPathNote }` (`proxyDriversInfo()`; `uses*` default `false`).
- `defaultProxyDriver` (`DEFAULT_PROXY_DRIVER_ID`), `caddyTlsModes` (`[...CADDY_TLS_MODES]`), `defaultCaddyTls` (`DEFAULT_CADDY_TLS`).
- `sources`: each non-secret key's `environment`/`settings`/`none`.
- `environment`: only env-pinned keys, `{ variable, value?, stored, storedValue? }`; `value` is the effective non-secret value, never present for a secret; `stored`/`storedValue` drive the "Stored copy" line operators check before deleting a `data/*.env` file.
- `secrets`: `{ set, source }` per secret, never the value.
- `derived` (`derivedValues()`): read-only resolved values: each host's `midScheme.gateway`, and the `proxy: true` entry's `ip` via `findProxyEntry` ("Proxy IP (firewall scope)").

### PATCH validation and refusals

Non-secrets validate against exported `SettingsSchema` (shared with `set-config`, so both reject identically); `null`/`''` clears like `--unset`. Secrets: string sets via `writeSecret`, `null`/`''` clears via `clearSecret`. Before writing anything, refuses:

- an env-pinned key: 400 naming the variable and its `data/*.env` file, telling the operator to unset it *and restart the service* (the CLI stores and warns instead, its environment not necessarily the service's);
- an admin-group change under which the real requester (`req.realUser ?? req.user`; never blocks the local operator) would fail `isAdminUser` (`adminGroupsWith`, `src/lib/authentik-config.ts`): 409;
- `webUiAuthMode: 'authentik'` unless the forward-auth headers name an admin under the post-save groups: 409, two messages (no headers, or non-admin identity). See Web UI authentication.
