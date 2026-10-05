# Web service

The Express web service under `src/web/`: authentication, admin gating, per-resource permissions, impersonation, the Dashboard guest-edit rules, the push-live step, and the server half of the Settings page.

Related nested files:

- Job runner, prompt relay, cross-process job watching/control, job attribution columns: see `src/web/jobs/CLAUDE.md`.
- Scheduler and the Tasks route (`src/web/routes/tasks.ts`): see `src/web/tasks/CLAUDE.md`.
- OIDC credentials and adoption routes (`src/web/routes/oidc.ts`): see `src/commands/networking/CLAUDE.md` (OIDC credentials and adoption).
- Shared operations (`commitGuestEdit`, `editDeletesOidcClient`, `previewAndEnqueue`): see `src/operations/CLAUDE.md`.
- Browser side (whoami store, Sidebar, Settings page UI, Advanced modal): see `web-client/CLAUDE.md`.
- Authorization rigor for the web UI is a root rule: see root `CLAUDE.md`, Project philosophy.

## Web UI authentication

`src/web/auth.ts`. A global `requireAuth` middleware, mounted in `src/web/app.ts` ahead of every route, trusts the `X-authentik-*` identity headers that the `proxy: true` entry's proxy adds after checking the request against Authentik (Caddy's `forward_auth`, nginx's `auth_request`). There is no OIDC client, login page, or session store in this repo: Authentik and the proxy own the session; the app only reads already-verified headers (`resolveAuthUser`, exported standalone for the WebSocket path). Forward-auth at the proxy was chosen deliberately over an app-embedded OIDC client.

- `req.user.groups` is the one field an active impersonation can overlay after `requireAuth`; every other `req.user` field and `req.realUser` (when set) stay the real, header-verified identity.
- `resolveAuthUser` reads `x-authentik-uid` into `AuthUser.uid` when present and non-empty: Authentik's stable per-user id (usernames do get renamed). Absent for dev/test identities and the local operator. `Actor` (`src/lib/pve-acl.ts`) carries an optional `uid` copied by `resolveActor` so `creatorFromActor` can record it; `applyImpersonation` leaves `uid` alone (it only replaces `groups` and sets `impersonating`), because `isGuestCreator` keys off `impersonating`, not a missing `uid`.

### webUiAuthMode

The `webUiAuthMode` setting (`WEB_UI_AUTH_MODE` env var overrides it), read through the config accessor on every request by `authMode()`:

- `auto` (default): falls back to a synthetic always-admin local operator when no trusted headers are present.
- `authentik`: requires the headers, 401 otherwise.
- `none`: ignores headers entirely.

**The production deployment must store `webUiAuthMode=authentik`** (or pin it with the env var). Under `auto`, a proxy config that lost its forward-auth directive silently serves every request as a full-admin local operator instead of failing closed. With it stored, deleting `data/authentik.env` after the import keeps sign-in required.

Lockout guards (the setting is web-editable):

- `AuthUser.viaForwardAuth` is set by `resolveAuthUser` only on the `x-authentik-username` branch (never for the dev user or local operator) and survives the impersonation overlay.
- A Settings PATCH that sets `authentik` re-parses the request's own headers with `forwardAuthIdentity` (same parse, regardless of mode: in `none` mode `req.user` is the local operator even when the proxy sent headers) and refuses (409) unless they name a user who passes `isAdminOf` under the admin groups that same PATCH leaves in place. The server `logWarn`s who left `authentik`; the page confirms first.
- CLI/MCP writes are unrestricted (host-level trust), which is the recovery path: `set-config webUiAuthMode auto --apply` on the host, or the env var (`docs/authentik.md`, "Locked out").

`WEB_UI_DEV_USER` simulates a specific non-admin group membership (the local operator can't). It takes effect in every mode, even `authentik`, so it must stay unset in the production service environment (`scripts/windows-service.ts`'s `buildService()` never sets it).

### Admin predicate

`isAdminUser` (`src/web/auth.ts`) is the single admin predicate. Its groups are the `authentikAdminGroup`/`authentikBuiltinAdminGroup` settings (overridden by `AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`), read via `authentikConfig()` (`src/lib/authentik-config.ts`), defaulting to `bellhop-admins`/`authentik Admins`. Membership in either is sufficient, so the built-in Authentik admin group is always a path into the admin pages without an out-of-band group edit. These gate this app's own admin pages and are unrelated to `AUTHENTIK_GROUP_LADDER` (whose top rung is the admin-only tier for a gated inventory entry; see `src/commands/networking/CLAUDE.md`).

### WebSocket path

The `/ws/jobs/:id` upgrade handler (`src/web/routes/jobs.ts`) is wired onto the raw `http.Server`, so Express middleware never sees it. It calls `resolveAuthUser` itself at the top of its `'upgrade'` listener, and duplicates `applyImpersonation`'s overlay and the creator map inline (kept in sync by hand; no shared helper until a third bypass point exists). Without this the job-log WebSocket would be unauthenticated.

### Firewall scope and HAProxy

None of this is safe on its own: it depends on the Windows firewall rule `scripts/windows-service.ts`'s `addFirewallRule` installs being scoped to `remoteip=<proxy host's IP>`. `resolveProxyIp` derives that from `findProxyEntry`/`proxy: true` (errors name `'proxy: true'`), so the rule follows the proxy if it moves. That scope is what stops anything but the proxy from reaching the app and spoofing the trusted headers. Whichever driver runs on the `proxy: true` entry fronts the web UI; the scope follows the entry, not the driver.

Under the HAProxy driver Bellhop cannot forward-gate the web UI's own subdomain, and every Bellhop backend strips `X-authentik-*`, so routing the web UI through a Bellhop HAProxy backend under `webUiAuthMode: authentik` only gets 401s. The operator must mark that entry `proxyManual` and hand-author its routing with their own Authentik forward-auth (e.g. the community Lua integration), which must overwrite, never pass through, the `X-authentik-*` headers. Production still keeps `authentik` (see "Limits" in `docs/reverse-proxy/haproxy.md`).

## Inventory reload

The service loads `inventory` once at startup (`src/web/server.ts`), then a global middleware in `buildApp` (`src/web/app.ts`) calls `refreshInventory(deps.inventory, deps.inventoryPath)` (`src/lib/inventory.ts`) on every `/api` request. It `loadInventory`s and `Object.assign`s every field onto the *existing* object, so every route closure over it sees fresh data; a direct DB edit or a CLI run shows up without a restart (#98). A failed reload (e.g. a transient lock) is `logWarn`ed and swallowed; the request uses the last good copy. The same middleware also invalidates the config snapshot (see `src/lib/CLAUDE.md`, Settings store).

Gotcha: `inventory` is shared and mutable across `await`s (e.g. `syncProxyLive` in `src/web/proxy-sync.ts` reads `deps.inventory` across an SSH + Authentik round trip), so a concurrent request's reload can change it mid-handler. Snapshot it locally if a handler needs it constant across an `await`.

## Users and groups

`src/web/routes/users.ts`, `src/web/routes/groups.ts`: full CRUD on Authentik users/groups, gated by `requireAdminGroup` (checks `req.user.groups` via `isAdminUser`) plus `requireUserDirectory` (both in `src/web/auth.ts`). See "Running without Authentik" in `docs/authentik.md` for the no-URL/token case.

- `GET /api/whoami` (`src/web/routes/dashboard.ts`) returns `isAdmin`, `adminGroups`, and `capabilities` (including `capabilities.userDirectory`); the admin group names have exactly one definition (`authentikConfig()`), and the client reads them from this route instead of duplicating them. Client store: see `web-client/CLAUDE.md` (`WhoAmIProvider`).
- Creating a user never collects a password: `POST /api/users` immediately calls Authentik's recovery-link endpoint and returns the link for the admin to share. The same recovery-link generation is exposed standalone for a locked-out user.
- Self-lockout guard: `DELETE /api/users/:id` and `POST /api/users/:id/deactivate` return 400 when the target is the requesting admin's own account.
- This is administration only; what a user may see elsewhere is the permissions layer below.

### AuthentikClient

`src/lib/authentik-client.ts` wraps Authentik REST API v3 in the `SSHClient` injection pattern: `RealAuthentikClient` when the `authentikApiUrl` setting and `authentikApiToken` secret (or `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN`) are both set (`authentikConfigured()`), otherwise `UnconfiguredAuthentikClient`, which fails every call with the same clear "not configured" error so call sites need no null check. `buildAuthentikClient()` returns a live client (`liveClient`) that re-decides on every method call, so the web service and MCP server build it once and still follow a later save; `isConfigured()` follows too, and with it `requireUserDirectory` and `capabilities.userDirectory`. `data/authentik.env` is now only a one-time import source and, while present, an override.

`RealAuthentikClient` has no live-instance test (verify manually). `test/lib/authentik-client.test.ts` pins request bodies/response mapping with a stubbed `fetch` (`withStubbedFetch`). `listOAuth2Providers()` in particular is tested because it must filter: in Authentik (2026.8, verified live) a proxy provider is a subclass of OAuth2Provider, so `GET /api/v3/providers/oauth2/` also returns every proxy provider, with `meta_model_name`/`component` reporting OAuth2 values. Only membership in `GET /api/v3/providers/proxy/` tells them apart, so `listOAuth2Providers` fetches that list and drops its pks. Callers (`ownedProviderKind`, `planProviderName`, `adopt-oidc-client.ts`, `oidc-credentials.ts`) rely on that and never re-check.

### web:dev admin caveat

`npm run web:dev` sets `WEB_UI_DEV_GROUPS=bellhop-admins` with `WEB_UI_DEV_USER` (both read by `resolveAuthUser`'s dev fallback) so `/users` is reachable without Authentik. The script hardcodes the *default* admin group name. If the checkout's effective `authentikAdminGroup` (or `AUTHENTIK_ADMIN_GROUP`) is anything else, the dev session is **not** admin: the auth-group dropdown's `canLower` comes back `false` and widening/clearing a tier is refused as for a real non-admin. Fix locally by changing `authentikAdminGroup`/`AUTHENTIK_ADMIN_GROUP` or overriding `WEB_UI_DEV_GROUPS` to match.

## Per-resource permissions

`src/web/access.ts`, `src/web/routes/permissions.ts`, over the pure `isAllowed` in `src/lib/permissions.ts` (see `src/lib/CLAUDE.md`). Tables `permission_groups`/`permission_rules` in `inventory/bellhop.db` sit outside `saveInventory`'s delete-and-reinsert and record each group's mode (`allow-list` or `block-list`) and its host/guest list. A group with no `permission_groups` row is unrestricted. The admin-only Permissions page edits them.

- `isResourceAllowed`/`filterInventoryForUser` add an admin bypass (`isAdminUser`) on top of `isAllowed`. Multi-group access is an intersection: the most restrictive group wins, never widened by a more permissive one.
- Enforcement: read-filtering on `GET /api/inventory` and `GET /api/guests/status`; `requireResourceAccess` (middleware or inline) on every route that mutates a specific host/guest: the Dashboard guest PATCH, `guest-power`/`set-guest-vpn`, `update-app`, the VPN gateway proxy routes, and every provisioning command's `preview`/`apply`.
- Fleet-wide actions with no single target (`update-all`, `audit-nfs-mounts`, `sync-ssh-keys`, `push-ssh-key`, `sync-inventory`, `sync-proxy`) stay admin-only via `requireAdminGroup`, not filtered.
- External sites are out of scope (not exposed by `GET /api/inventory`, not on the Dashboard).
- Host and guest rules are independent: blocking a host hides only the host entry, never its guests.

### Job visibility (`isJobVisible`)

`GET /api/jobs(/:id)` and cancel/answer/dismiss-prompt filter in `src/web/routes/jobs.ts`. A job's `target` (`src/web/jobs/job-store.ts`) is a bare name with no resource type, so `isJobVisible` matches group rules by name alone instead of reusing `isResourceAllowed` (which needs a type). Do not check the name as both host and guest and OR the results: a block-list rule tagged with the "other" type would leak the job, since a missing row under the untagged type defaults to allowed.

### Creator access

A user in an allow-list-restricted group keeps access to a guest they created through the web UI (#58).

- `isGuestCreator(creator, caller)` (`src/lib/permissions.ts`): `false` while impersonating (an admin's creator access never leaks into an impersonated view); `false` with no recorded `creator`; uid comparison when both sides carry a uid; username comparison otherwise.
- `isAllowed`'s `opts.isCreator`: for a `guest` ref only, an allow-list group treats the guest as listed. A block-list group is unchanged: an explicit block wins regardless of creator.
- `isResourceAllowed`/`filterInventoryForUser` take an `AccessCaller` (structural subset of `AuthUser`: `groups`/`username`/`uid`/`impersonating`), not bare `groups[]`, and resolve the creator from the in-memory `Inventory`.
- `isJobVisible` takes the job row (`{ target, startedAt }`) and `creators: Map<guestName, GuestCreator>` from `guestCreators(inventory, hosts)`, built once per request, so a job targeting a guest the caller created is visible and controllable. Two limits keep the lift on the caller's own guest:
  - `guestCreators` omits any guest whose name equals a host name, since guest-creating commands record the *host* as job target and such a guest would expose every job on that host (deliberately not a `validateInventory` rule, which could make a saved inventory unloadable).
  - Only a job that started at or after the creator's `since` (ISO-8601, `created_by_since` column) is lifted, so a guest re-created under a reused name never exposes the old guest's jobs. No `since`, or a job not yet started: no job lift (fail closed). Guest access itself never reads `since`.
- Writers: `recordProvisionedGuest`'s `create-lxc`/`create-vm`/`install-app` paths and `deploy-vpn-gateway`'s operation (`src/operations/provisioning.ts`) set `creator` from `creatorFromActor(deps.actor, deps.now?.())`. `deps.actor` is the real, never-impersonated person, or `undefined` for MCP/CLI/local operator, so only those get no record. `since` comes from that clock (`OperationDeps.now`) or, for `backfill-guest-creators`, the creating job's `startedAt` (see `src/commands/maintenance/CLAUDE.md`).
- Preservation: `upsertGuestEntry` keeps an existing `creator` on a repeat apply with no actor and replaces it on one with an actor; `sync-inventory`'s `{ ...existing }` merge and `migrate-guest`'s rewrite keep it; it disappears with the guest row.
- Not editable: `applyGuestEdits` (`src/operations/edit-guest.ts`) copies only named fields, so a `creator` in a Dashboard PATCH is ignored; MCP `edit_guest`'s `EDIT_GUEST_SHAPE` strips unknown keys. The Advanced modal shows a read-only "Created by" username; the uid is never shown.

### Filtered inventory and used MIDs

Because `GET /api/inventory` is filtered, nothing that must account for *every* guest may be computed from it in the browser (#54). The provisioning MID suggestion, migrate-guest's preferred-MID collision check, and the MID collision warning read `GET /api/provisioning/used-mids`: occupied MID numbers per visible host, from the unfiltered inventory, never guest names. The warning names a guest only if it is visible to the caller. Likewise `checkVmidAvailable` takes an optional `canSeeGuest` (`OperationDeps.canSeeGuest`, built per request by the provisioning routes from `isResourceAllowed`) and drops the occupying guest's name when the caller can't see it; CLI and MCP pass none.

## Admin impersonation

`src/web/impersonation.ts`, `src/web/routes/impersonation.ts` (#101). An admin views/acts as if they belonged only to one chosen non-admin group, to test that group's rules without a second login.

- State is in-memory only: `ImpersonationStore`, a `Map<realUsername, groupName>` keyed by the trusted `X-authentik-username` header. No cookie, no secret, nothing on disk; a restart clears it.
- `applyImpersonation`, mounted in `app.ts` right after `requireAuth`, overlays `req.user.groups` with the impersonated group and stashes the real identity on `req.realUser`. Every permission check (`isResourceAllowed`, `requireResourceAccess`, `isJobVisible`, `requireAdminGroup`) reads only `req.user.groups`, so this single overlay point is the whole mechanism.
- `POST`/`DELETE /api/impersonate` (the only routes touching the store) use a separate `requireRealAdminGroup` that checks `(req.realUser ?? req.user).groups`. This is load-bearing: with `requireAdminGroup` an impersonating admin would get 403 on the endpoint that turns impersonation off, locked in until restart.
- The two admin groups are excluded from the picker and rejected server-side (impersonating one is a no-op).
- `resolveTriggeredBy(req)`/`resolveActor(req)` (`src/web/impersonation.ts`) use the real user (`req.realUser ?? req.user`); `resolveActor` returns `undefined` for the local operator. Job attribution columns (`triggered_by_*`): see `src/web/jobs/CLAUDE.md`. Sidebar start/stop and its `refresh()` behavior: see `web-client/CLAUDE.md`.

## Dashboard guest edits

The guest PATCH handler is in `src/web/routes/dashboard.ts`; the shared commit logic (`commitGuestEdit`, the OIDC client deletion confirmation `editDeletesOidcClient`/`OIDC_CLIENT_DELETION_CONFIRMATION_ERROR`, conflict/skip echoes) is in `src/operations/edit-guest.ts` (see `src/operations/CLAUDE.md`). Authentik-side reconcile: see `src/commands/networking/CLAUDE.md` (sync-authentik).

### authGroup raise/lower

Changing an entry's tier is asymmetric, enforced server-side in the handler via `isAdminUser` (so with the same impersonation behavior as everywhere else):

- Anyone with resource access may *raise* it: a narrower rung, or gating an ungated entry.
- Only an admin may *lower* it: a broader rung, or clearing the gate.

`GET /api/auth-groups` (`src/web/routes/auth-groups.ts`) supplies the rung options; it is authenticated but deliberately not admin-gated, since a non-admin needs the rungs to raise a tier.

### unauthenticatedPaths add rule

Adding a path exemption is the privileged operation (only adding can make something reachable without permission):

- Anyone with resource access may narrow: remove paths, clear the list, or reorder. Order is compared as a set, so reordering is never an addition.
- Adding a path to an entry whose *resulting* `authGroup` (after this request's own `authGroup` edit) is set requires the caller to reach that app: admin, or member of that rung or any rung above (`rungsAtOrAbove`); otherwise 403.
- On an entry with no `authGroup` it is unchecked: the field is inert there (drivers only render exemptions for a forward-gated route), so there is nothing to widen.

Known consequence: a non-admin may add exemptions to an ungated entry and then gate it (a "raise"), yielding a gated entry with every path exempt. Not an escalation (the app was already public; the caller only fails to narrow), but a "raise" alone does not guarantee an app is protected.

### OIDC field edits (`oidcEditChangeError`)

Changing `authMode`, `oidcRedirectUris`, or `oidcMobileRedirectUris` is admin-only in both directions, with no raise/lower exception: switching to OIDC removes the proxy's forward-auth gate, and a callback URL (web or mobile) decides where a completed login is sent, so no such edit is purely narrowing. `oidcEditChangeError` enforces it whenever the body touches any of the three, comparing the *parsed* current vs. updated entries (order-sensitive) rather than the raw body, so resending an unchanged value is not a change.

### Live TLS-backend probe

The handler probes with `probeInsecureBackendTls` (`src/lib/tls-probe.ts`; see `src/lib/CLAUDE.md`) single-shot (no retries; an edited guest is presumed running), only when the edit changed `subdomains`/`port` and the resulting entry isn't `proxyManual`. A conclusive result overwrites any `insecureBackendTls` the same request submitted; an inconclusive one leaves the submitted/stored value. The probe never throws.

## Push-live step (`syncProxyLive`)

`src/web/proxy-sync.ts`'s `syncProxyLive` runs `sync-proxy`, `render-status-page`, `sync-authentik`, then `prune-acme-challenges`, as one step. Every Dashboard subdomain/`authGroup`/OIDC edit and the provisioning applies with subdomains trigger it, so an OIDC client is created/updated/deleted in the same request.

- When `sync-proxy` throws (failed write/validate, or a route the Nginx Proxy Manager driver reports as a conflict on every sync), the step warns, skips `render-status-page` and `prune-acme-challenges`, still runs `sync-authentik` normally, then rethrows the original `sync-proxy` error (an operator decision). So a lasting proxy conflict elsewhere never stops a save from reconciling Authentik, while callers still report the failure (`proxySynced: false`/`proxyError` from `commitGuestEdit`, a failed provisioning job). A `sync-authentik` error on that path is only warned, never masking the proxy error. Applies to every driver; the CLI's `sync-proxy` is unchanged.
- Ordering consequence: proxy config is written *before* Authentik sync, so switching to OIDC drops the `forward_auth` gate first; a skipped or failed Authentik sync leaves the app ungated at the edge until the next successful one. A failed proxy sync does not cause this, since `sync-authentik` still runs.
- Results surfaced to callers include `authentikConflicts`, `authentikAdoptableConflicts`, `authentikOidcSkipped`, `authentikForwardSkipped`, OIDC discovery failures, and `authentikMobileConsentProblems`; `commitGuestEdit` narrows them to the edited guest. The guest PATCH runs outside any job, so returning these is how they reach the user rather than a `logWarn` to stderr. Status-page and prune skip/failure rules: see `src/commands/networking/CLAUDE.md`.

## Provisioning routes: inventory upsert

`src/web/routes/provisioning.ts`. The CLI's `create-lxc`/`create-vm`/`install-app` never touch `inventory/bellhop.db`; the web route layer does (the command functions stay inventory-agnostic). On a successful apply, `recordProvisionedGuest` upserts the new guest immediately (name/type/vmid/host/ip from the resolved MID, plus any `subdomains` from the form) instead of waiting for Sync Inventory. With `subdomains`, it also awaits `syncProxyLive` in the same job, so the apply succeeds only once they are live.

When the entry has a concrete `ip` + `port` + non-empty `subdomains`, `recordProvisionedGuest` runs the TLS-backend probe with a ~3-minute budget (6 retries, 30s apart, one job-log line per attempt). In practice only `install-app` hits this, since the `create-lxc`/`create-vm` forms collect no `port`; those guests are probed the first time a Dashboard edit sets `port` + `subdomains`. A conclusive result overwrites the submitted `insecureBackendTls`. The CLI has no per-guest hook, so it stays fully manual.

The provisioning router's `deps()` sets `actor` via `resolveActor(req)` and `canSeeGuest` from `isResourceAllowed`.

## App updates route

`GET /api/app-updates` (`src/web/routes/app-updates.ts`) reads every `app_update_status` row and drops one whose guest is no longer an eligible `lxc` + `app` guest in the live inventory, whose stored `app` differs from the guest's recorded `app` (a repurposed guest never shows the old app's result), or whose guest the caller can't see. Visibility is one `filterInventoryForUser` call per request, so the route needs no admin gate. The check itself: see `src/commands/maintenance/CLAUDE.md` (check-app-updates).

## Settings page (API)

`GET`/`PATCH /api/settings` (`src/web/routes/settings.ts`), gated by `requireAdminGroup` like Users/Permissions; non-admins and impersonating admins get 403 on both. Unlike Users/Permissions, the Settings nav shows for any admin even without Authentik's user directory: it needs only an identity, not Authentik's REST API. Storage, precedence, and secrets: see `src/lib/CLAUDE.md` (Settings store). Page UI (`proxyDriverOptions`, `caddyTlsOptions`, `proxyFieldView`, field show/hide, `SETTINGS_TABS`, confirmations, `adminNavLinks`): see `web-client/CLAUDE.md` (Settings page).

### settingsResponse()

Shared by GET and PATCH so the two never disagree. Fields:

- `settings`: only *stored* non-secret values (what the inputs edit).
- `proxyDrivers`: every driver from `listDrivers()` in registration order, each `{ id, label, defaultConfigPath, suggestedStatusPagePath, managesProxy, usesSharedCertificate, usesCertResolver, usesApiUrl, usesCaddyTls, usesNpmApi, configPathNote }` (built by `proxyDriversInfo()`; the `uses*` flags default `false`).
- `defaultProxyDriver` (`DEFAULT_PROXY_DRIVER_ID`), `caddyTlsModes` (`[...CADDY_TLS_MODES]`), `defaultCaddyTls` (`DEFAULT_CADDY_TLS`).
- `sources`: every non-secret key's `environment`/`settings`/`none`.
- `environment`: only keys an env var currently pins, `{ variable, value?, stored, storedValue? }`. `value` is the effective value for a non-secret key and never present for a secret; `stored` (and `storedValue` for a non-secret) lets the page show a "Stored copy" line, which is how an operator confirms the import before deleting a `data/*.env` file.
- `secrets`: `{ set, source }` per secret, never the value.
- `derived` (built by `derivedValues()`): read-only values the toolkit resolves, not settings: each host's `midScheme.gateway`, and the `proxy: true` entry's `ip` via `findProxyEntry` (shown as "Proxy IP (firewall scope)").

### PATCH validation and refusals

Non-secret values validate against the exported `SettingsSchema`, the same schema `set-config` uses, so the CLI and the page reject identically; `null`/`''` clears like `set-config --unset`. Secret keys are accepted too: a string sets via `writeSecret`, `null`/`''` clears via `clearSecret`. Before writing anything, PATCH refuses:

- an env-pinned key: 400, naming the variable and its `data/*.env` file, and telling the operator to unset it *and restart the service* (the CLI instead stores and warns, since its environment isn't necessarily the service's);
- an admin-group change under which the real requester (`req.realUser ?? req.user`; never blocks the local operator) would stop passing `isAdminUser` (`adminGroupsWith`, `src/lib/authentik-config.ts`): 409;
- `webUiAuthMode: 'authentik'` unless the request's forward-auth headers name an admin under the post-save groups: 409, with two messages (no headers, or a non-admin identity). See Web UI authentication above.
