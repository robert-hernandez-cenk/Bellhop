# Networking commands

Scope: the Authentik reconcile (`sync-authentik`), OIDC credentials and adoption, `prune-acme-challenges`, and `render-status-page`.

Elsewhere:

- `sync-proxy` (`runSyncProxy`: `managesProxy` short-circuit, capability refusal, `requireOutpost`): see `src/lib/proxy/CLAUDE.md` (driver interface).
- `convert-caddyfile`: see `src/lib/proxy/drivers/CLAUDE.md` (Caddy admin-API driver).
- Dashboard tier raise/lower rule and the `unauthenticatedPaths` add rule: see `src/web/CLAUDE.md` (guest PATCH authorization).
- `syncProxyLive` push-live step: it runs `sync-proxy`, `render-status-page`, `sync-authentik`, then `prune-acme-challenges`. For its ordering, failure rules, and Dashboard echoes see `src/web/CLAUDE.md` (push-live step).
- OIDC client deletion confirmation (`editDeletesOidcClient`, `confirmOidcClientDeletion`) and `commitGuestEdit`: see `src/operations/CLAUDE.md`.
- `cloudflare` being required on `OperationDeps`: see `src/operations/CLAUDE.md`.

## sync-authentik

`src/commands/networking/sync-authentik.ts` is the Authentik counterpart of `sync-proxy` for per-app gating (#80). REST-only, no SSH. Standard dry-run/`--apply`. It reconciles Proxy Providers, Applications, policy bindings, and embedded-outpost membership against every gated inventory entry (one whose `authGroup` names a rung).

### Slugs and naming

- The Application slug is the entry's canonical subdomain, `subdomains[0]`. No Authentik object IDs are persisted to `inventory/bellhop.db`.
- The slug is also the Application's and the provider's display name, verbatim (#156). Only the Proxy Provider's `externalHost` (`https://<slug>.<domain>`) appends the domain, since Authentik matches incoming forward-auth requests against it.
- `toCreate`/`toRemove`/`conflicts` hold bare slugs. `src/web/routes/dashboard.ts` compares `subdomains[0]` against them to scope the conflict banner to the edited guest. Keep the two in lockstep: a mismatch fails silently by rendering no banner.

### Group-ladder bindings

- Reconciled on every `--apply` (#158). Each gated Application is bound to the entry's rung and every rung above it (`rungsAtOrAbove` in `src/lib/authentik-config.ts`). `AUTHENTIK_GROUP_LADDER` is comma-separated, low to high, default `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins`. Authentik ORs bindings (`policy_engine_mode: any`), so the top rung is effectively admin-only.
- Missing wanted bindings are created. An existing binding whose group is on the ladder but no longer wanted is deleted. A binding to an off-ladder group (hand-added), or a policy-/user-backed binding, is never touched.
- A rung an entry needs that doesn't exist as an Authentik group goes in `missingRungs` and is never auto-created: an empty group made from a typo in `AUTHENTIK_GROUP_LADDER` would hide the mistake.
- An entry whose `authGroup` is not on the ladder is skipped entirely (no Application, no bindings) and reported in `offLadder`. It is not a `loadInventory` error, because `validateInventory` runs on every load and a ladder edit must never make a saved inventory unloadable.

### Application existence and ownership (#154)

- An entry whose gate is cleared has its Provider/Application deleted and removed from the outpost on the next `--apply`.
- A Proxy-backed Application is this command's to delete only if its slug matches an inventory subdomain and it is backed by a proxy provider. An Application with no provider, or one whose slug isn't in inventory (e.g. the `homelab.example.com` dashboard's own, or `qbittorrent` fronting an external seedbox through a hand-authored Caddy block), is never touched.
- An OAuth2-backed Application is owned only when its provider carries `meta_publisher: 'bellhop'` (`BELLHOP_META_PUBLISHER`), so a hand-made OpenID client sharing a slug never falsely matches. A Proxy Provider stays owned by slug alone, so Applications created before the marker existed are still recognized. `ownedProviderKind` (exported) decides this.
- If a gated entry's slug is held by an Application this command doesn't own, creating one would fail Authentik's unique-slug constraint. The entry is skipped and listed in `conflicts` (printed by the CLI; surfaced through `syncProxyLive` as `authentikConflicts`) rather than aborting the run, since one bad entry must not fail an unrelated Dashboard edit. The list is inventory-wide; the Dashboard filters it to the edited guest.
- Known limitation: a subdomain rename on a gated entry is not detected. The old slug falls outside the ownership rule, so its Application is left behind while a new one is created. Delete the old Provider/Application by hand. See `candidateEntries`'s comment.

### Native OIDC gating (#1)

For an entry where `effectiveAuth()` is `'oidc'`, the command maintains an OAuth2/OpenID Provider and Application instead of a Proxy Provider. It is bound by the same rung-and-above rule via the exported `planBindingChanges` (shared with `adopt-oidc-client.ts`) but never added to the forward-auth outpost.

Provider listing:

- Authentik 2026.8 quirk: a Proxy Provider subclasses OAuth2Provider, so `GET /api/v3/providers/oauth2/` returns proxy providers too. `RealAuthentikClient.listOAuth2Providers` (`src/lib/authentik-client.ts`) filters them out by cross-referencing the proxy list, so `ownedProviderKind`'s `proxyProviderIds`/`oauth2ProviderIds` sets can be built directly and checked independently (proxy first).
- OAuth2 providers are listed on every run, to compute ownership. Once any entry is OIDC, the `authentikApiToken` needs: read/write on OAuth2/OpenID Providers, read on certificate-keypairs and scope/property mappings, update on Applications (see "OIDC mode" in `docs/authentik.md`).
- `listOAuth2ProvidersForRun`: with no candidate in `authMode: 'oidc'` (gated or not), a failed OAuth2 listing is treated as empty, so a forward-only deployment with an older token keeps working. With any OIDC candidate, the failure propagates.

Client shape:

- Confidential client. `OIDC_GRANT_TYPES` (authorization-code + refresh-token) must be sent explicitly on create: otherwise Authentik silently stores `[]` and rejects every authorize request.
- Signs with the certificate-keypair named `AUTHENTIK_OIDC_SIGNING_KEY_NAME` (`authentik-config.ts`, default `'authentik Self-signed Certificate'`, which every stock install has; a single-operator default to override once you set up your own key). Resolved by `getSigningKeyId`.
- A new client releases the `openid`/`profile`/`email` mappings (`OIDC_SCOPE_MAPPINGS`), looked up by Authentik's stable `managed` identifier, not the editable display name.
- `resolveOidcInstanceSettings` makes one `listScopeMappings()` call (`?page_size=500`) per run, giving the three built-in ids and `scopeNameById` (id -> `scope_name`). Truncated-page guards read `pagination.count` (there is no top-level `count`); the same applies to `listPolicyBindings` and `listOAuth2Providers` (#16).
- Signing key and scope mappings are resolved once per run, only when some entry has redirect URIs to act on. Either failing skips every such entry (`missing-signing-key`/`missing-scope-mapping` in `oidcSkipped`) while forward-mode entries carry on.
- An entry with no `oidcRedirectUris` is skipped (`missing-redirect-uris`) and never PATCHed down to an empty callback list, which would lock out a working login.

Drift (`diffOAuth2Settings`):

- Compares redirect URIs (as a set of `(matchingMode, url)` pairs), grant types, scope mappings, signing key, and client type; returns the drifted field names plus a patch with only those fields. `oidcUpdates` reports drift fixed this run (e.g. `~ slug: redirect_uris, signing_key`).
- Redirect URIs come from the exported `clientRedirectUris(entry)`: web list plus mobile list, deduplicated, web first.
- Scope mappings, for an owned client and for `adopt-oidc-client`, compare by scope name (#16): each required scope is covered by its built-in id or any attached mapping with that scope name (custom allowed); other scopes are ignored. Only an uncovered required scope is `property_mappings` drift; the patch keeps every attached id in order and appends the built-in id per missing scope. This lets a custom mapping survive (e.g. a custom `email` mapping deriving `email_verified`, since the built-in one always reports `false`); the cost is that a built-in swapped for a same-scope-name mapping is never restored.
- Fail-safes: if any attached id is absent from the listing (scope unknown to the token), `property_mappings` is left alone entirely. A built-in id absent from the listing counts as covered only when that id itself is attached.
- A reused leftover provider (`planProviderName`'s `reuseId`) may be hand-made, so `diffOAuth2Settings(..., 'exact')` brings it to exactly the three built-ins, like a new client.
- Credentials are structurally absent from `DesiredOAuth2Settings`, so no drift fix or adoption can ever rotate `client_id`/`client_secret`.

### Mode switches (`ModeSwitch`)

- The Application (pk, slug, all bindings) is kept; only its provider is swapped, so a tier survives a switch.
- Authentik provider names are unique across every provider kind (verified on 2026.8), and both providers are named after the slug. So `planProviderName` first renames the outgoing provider to `'<slug> (replaced)'` (`REPLACED_PROVIDER_SUFFIX`), creates the new provider under the bare slug, repoints the Application, then deletes the renamed provider. The Application never points at nothing.
- A proxy-provider rename re-sends the provider's own `mode` (and `internal_host` in `proxy` mode): 2026.8 rejects a name-only PATCH with 400, and a fixed mode would convert a hand-made provider. `renameProxyProvider` takes the whole `AuthentikProxyProvider` for this.
- Repointing clears `meta_publisher` on oidc -> forward (a Proxy-backed Application is owned without it) and sets it on forward -> oidc.
- Known limitation: if a switch fails after the rename but before repointing, the `'<slug> (replaced)'` provider is stranded; switching back to that mode is then skipped as `provider-name-taken` (naming it, in `forwardSkipped`/`oidcSkipped`) until deleted by hand. An unused, correctly named leftover from other partial failures self-heals: `planProviderName` reuses it (`reuseId`/`orphan`).
- `forwardSkipped` mirrors `oidcSkipped`: a new forward-auth Application, or an oidc -> forward switch, whose Proxy Provider name is taken by an unrelated provider (`provider-name-taken`) is left alone and reported rather than failing the apply.

### Outpost membership

Reconciled on every `--apply`: every owned, desired, Proxy-backed Application's provider belongs on the embedded outpost; a retired one (removed, or switched to OIDC) does not. A provider left off by a partial failure self-heals, and the dry run previews the repair (`outpostChanges`). Hand-added providers are untouched.

### adoptableConflicts

Narrows `conflicts` to those with a path forward: an unowned Application backed by any OAuth2 provider can be adopted; one backed by a Proxy Provider or nothing stays `resolve-by-hand`. `conflictExplanation(slug, result)` is the single place the wording is chosen (used by `formatSyncAuthentik`, `syncProxyLive`'s job-log warnings, and delete-guest's pre-removal sync). `syncProxyLive` also returns `authentikAdoptableConflicts` so the Dashboard can offer adoption.

### Post-apply discovery check

After every real `--apply`, each OIDC entry that still has a Bellhop-owned client gets `<issuer>/.well-known/openid-configuration` fetched (`DISCOVERY_TIMEOUT_MS`, 10s) and checked for a 200 JSON response (`checkOidcDiscovery`). Never rolled back: the client is correct in Authentik and the usual cause is network-shaped.

`syncAuthentikFailed` drives the CLI's non-zero exit: true on `--apply` only, for a failed discovery check, an instance-wide `missing-signing-key`/`missing-scope-mapping` skip, or `mobileConsent.error`. Never for a dry run, a conflict, or a single entry's incomplete config (`missing-redirect-uris`, `provider-name-taken`). The web push-live step surfaces discovery failures as a warning (`oidcDiscoveryFailures`) instead of failing the save.

### Mobile consent step (#22)

When at least one `oidcMobileRedirectUris` is in effect, the command reconciles a one-click consent step on the shared authorization flow (`AUTHENTIK_AUTHORIZATION_FLOW_SLUG`). Four objects:

1. Consent stage `MOBILE_CONSENT_STAGE_NAME` (`'bellhop-mobile-app-consent'`, `mode: 'always_require'`).
2. Its flow binding (`evaluate_on_plan: false`, `re_evaluate_policies: true`, order `10`, matching the stock explicit-consent flow).
3. Expression policy `MOBILE_CONSENT_POLICY_NAME` (`'bellhop-consent-on-mobile-redirect'`).
4. A policy binding of it on the stage binding (`failure_result: false`).

Input: `mobileUriSet(desired)`, the sorted, deduplicated union of `oidcMobileRedirectUris` over every desired OIDC candidate (gated, has subdomains, `effectiveAuth() === 'oidc'`), regardless of that entry's ladder/conflict/skip state. A URI with no live client can never be a real `redirect_uri`, and this keeps the policy stable while an unrelated problem is being fixed.

`renderMobileConsentExpression(uris)` renders a Python body: a sorted `MOBILE_REDIRECT_URIS` set literal (each URI a `pythonStringLiteral`, escaping non-printable-ASCII by code point, not UTF-16 unit, so a surrogate pair isn't rendered as two lone surrogates that never match), then a check of `request.context.get("goauthentik.io/providers/oauth2/params").redirect_uri` against the set. Its first line is `MOBILE_CONSENT_MARKER`.

Fails closed: a missing `params` evaluates to `None`, never in the set, so the stage is skipped; a thrown exception under `failure_result: false` does the same. Neither ever blocks a login.

Ownership and order:

- A policy is Bellhop's only when its expression starts with `MOBILE_CONSENT_MARKER`; a stage only when it is a consent stage. A same-named object failing the check is a conflict (`mobileConsent.conflicts`): the whole consent reconcile is skipped that run, nothing touched, and it never fails the run.
- Creation order: stage -> policy -> binding -> policy binding. Deletion (set empty): the reverse. Only owned objects are touched, so a hand-added binding/policy on the same stage binding survives.
- `applyMobileConsent` rolls back a stage binding created this run if its policy binding then fails (otherwise it would gate every login on the flow). A pre-existing stage binding (repair case) is left in place on the same failure.
- The flow cache is cleared (`POST /api/v3/flows/instances/cache_clear/`) after any run that changed the binding or policy, including the rollback case and even if a later step failed. A stage-only repair (just `mode`) needs no clear, since the stage reads its mode at execution.

Failure isolation:

- The consent reconcile runs in its own `try/catch` after every other step (after group bindings, before discovery). A thrown error becomes `mobileConsent.error` (message plus a hint naming `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` and the token's stage/policy/flow permissions); the rest of the run completes.
- When the mobile URI set is empty, a failure while only reading the four objects (or resolving the flow) is swallowed and planned as nothing to do, like `listOAuth2ProvidersForRun`. An older token with no mobile URLs never sees a new error. Trade-off: owned leftovers from an under-permissioned run wouldn't be cleaned up, which that combination can't have created.
- `syncProxyLive` logs `mobileConsent.conflicts`/`.error` via `logWarn` and returns them as `SyncProxyLiveResult.authentikMobileConsentProblems` (conflicts, then error).

Scope limits: the step is bound only to the `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` flow, so a client using another authorization flow gets mobile URIs in `redirect_uris` but no consent step. `adopt-oidc-client` writes `redirect_uris` (web + mobile) but doesn't reconcile the consent step; the next `sync-authentik` run (or Dashboard edit) creates it.

### How results reach the Dashboard

The Dashboard guest PATCH calls `syncProxyLive` straight from its Express handler, outside any job, so a `logWarn` alone would only reach the service's stderr. Hence results are also returned (the `logWarn` still runs for provisioning-job callers inside `withCapturedConsole`):

- `authentikConflicts`, filtered to the edited guest's subdomain, rendered as a banner by `EditableAuthGroup`/`EditableSubdomains`.
- `authentikAdoptableConflicts`, narrowed by `commitGuestEdit` to `authentikConflictAdoptable: true`, so `AuthentikConflictBanner` (`AuthentikSyncBanners.tsx`) offers the Adopt button (admin, OIDC-effective guest) or a "switch to OIDC mode, then adopt" note (forward-mode guest) instead of "resolve by hand".
- `authentikMobileConsentProblems`: instance-wide, so `commitGuestEdit` echoes them as `mobileConsentProblems` only when the edit changed that guest's `oidcMobileRedirectUris` (order-sensitive compare). Shown as a banner under the mobile redirect URL field; MCP `edit_guest` returns the same.

### Live-verified Authentik 2026.8 API quirks

- `GET /api/v3/policies/all/` ignores its `name` filter, so `findPolicyByName` matches client-side.
- `GET /api/v3/flows/bindings/` ignores `target__slug` (`target=<pk>` works), so bindings are listed by the resolved flow pk and filtered to the owned stage's `stageId` in code.
- Policy bindings on a flow-stage binding are filtered by `GET /api/v3/policies/bindings/?target=<pk>` using the binding's `policybindingmodel_ptr_id` (the plain `pk` fails with `"Select a valid choice"`), yet the listing's `target` field reports the plain `pk`. So a listed policy binding is matched against either `AuthentikFlowStageBinding.id` or `.policyBindingModelId`, and new ones are created with `target: policyBindingModelId` (what Authentik's admin UI sends).

## OIDC credentials and adoption (#1)

`oidc-credentials.ts`, `adopt-oidc-client.ts`, and `src/web/routes/oidc.ts`. Admin-gated everywhere they're exposed.

### oidc-credentials

- `oidc-credentials <entry>` (CLI, read-only, no `--apply`) and `GET /api/oidc/:entry/credentials` (web, router-wide `requireAdminGroup`, `Cache-Control: no-store`) find an OIDC-effective entry's owned client via `ownedProviderKind` and return issuer, client ID, and client secret read live from Authentik (`getOAuth2Credentials`). The secret is never in the inventory, job history/logs/jobs database, or any MCP response.
- `runOidcClientInfo` is the MCP-safe wrapper: it drops the secret from its own return value before the MCP layer holds it. The `get_oidc_client` tool (`src/mcp/build-server.ts`) calls only this; its `secretAvailableFrom` points at the Dashboard or the CLI command.
- The Dashboard's `OidcCredentials.tsx` calls the web route; a non-admin (including under impersonation, since `isAdminUser` reads the overlaid groups) sees a plain "OIDC (credentials visible to admins)" note.

### adopt-oidc-client

- CLI `adopt-oidc-client <entry> [--apply]`, web `POST /api/oidc/:entry/adopt/preview` and `/apply` (`AdoptOidcClientButton`), and MCP `adopt_oidc_client` (`fleetWide: true`, since `entry` may be a host or external site) all go through `runAdoptOidcClient`, so the front ends can't disagree.
- It sets `meta_publisher: 'bellhop'`, PATCHes drift via `diffOAuth2Settings` (never touching credentials), and reconciles ladder bindings via `planBindingChanges`: the same three steps a sync performs for an owned OIDC entry, for one entry.
- `formatAdoptOidcClient` mirrors `formatSyncAuthentik`'s layout.
- Refuses: an entry that isn't OIDC-effective, an Application already owned (either kind), or one not OAuth2-backed.

## prune-acme-challenges (#162)

`src/commands/networking/prune-acme-challenges.ts` deletes stale `_acme-challenge` TXT records in the inventory `domain`'s Cloudflare zone, left by Caddy `cloudflare`-mode DNS-01 issuance (aborted issuance, restart mid-challenge, removed or renamed subdomain). Standard dry-run/`--apply`; a failed delete is reported and the rest proceed (CLI exit 1).

### Ownership: age-based and zone-wide

A record is deletable when its name is `_acme-challenge.<domain>` or `_acme-challenge.<labels>.<domain>` (case-insensitive), its type is `TXT`, and `modifiedOn` is more than 24h old (`STALE_AFTER_MS`, not configurable). Unlike `sync-authentik`, it is not inventory-scoped, because that would never catch a removed/renamed subdomain's record, the main case. Age keeps it safe: a challenge record matters only for minutes, so a day-old one is in use by no ACME client on the zone.

Never deleted, however old: a `CNAME` at `_acme-challenge` (DNS-01 delegation), a record with no parseable `modifiedOn`, and a Cloudflare-managed record (`meta.read_only`/`meta.auto_added`, e.g. its Universal/Advanced cert validation TXT, mapped to `CloudflareDnsRecord.managedByCloudflare`).

The client lists every TXT record with no server-side name filter (no filter could be verified against the live zone), and the command does all name matching.

### Client and credential

- `CloudflareClient` (`src/lib/cloudflare-client.ts`), REST-only, real/unconfigured null-object pattern like `AuthentikClient`. `buildCloudflareClient()` returns a live client that re-reads config on every call (see `src/lib/CLAUDE.md`, Settings store).
- Credential: the `cloudflareDnsApiToken` secret setting (Zone:Read + DNS:Edit, minted for this alone), overridable by `CLOUDFLARE_DNS_API_TOKEN`. `data/cloudflare-api.env` is only a one-time import source and, while present, an override.
- Not `data/cloudflare.env` (the `cloudflare-ddns-lxc` answer file, read by nothing in `src/`). The variable name differs from the `CLOUDFLARE_API_TOKEN` Caddy and DDNS use, so each token is independently revocable.
- Every `RealCloudflareClient` request carries `AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS)` (10s); a timeout throws like any request failure.

### When it runs

- Inside `syncProxyLive` (`src/web/proxy-sync.ts`) it is the last step and never fails the caller. If the active driver's `capabilities.acmeDns01ViaCloudflare(inventory)` (via `getDriver(inventory)`) is false, it logs one skip line (`pruneAcmeDriverSkipMessage`: "is not configured to use ACME DNS-01 via Cloudflare") without touching Cloudflare. An unconfigured client logs its own skip line. Any thrown error becomes a `logWarn`. `SyncProxyLiveResult` carries nothing for these.
- `acmeDns01ViaCloudflare(inventory)` is false for nginx, Nginx Proxy Manager, HAProxy, and `none` always; for a Caddy driver unless `proxyCaddyTls` is `cloudflare`; for Traefik only when `proxyCertResolver` is the reserved `none` (any other resolver might be Cloudflare DNS-01).
- Only the guest-edit and create/install/delete-guest paths prune. `sync-proxy`, `render-status-page`, and `migrate-guest` (CLI, web, MCP) call `runSyncProxy`/`runRenderStatusPage` directly, so a migration or manual proxy push never prunes.

## render-status-page

`src/commands/networking/render-status-page.ts` writes a static HTML page to `statusPagePath` (#124) on the `proxy: true` entry: the document root served by a hand-authored `caddy.example.com` block via `file_server`. That block is outside any driver's managed section, and is hand-restricted to LAN ranges (Caddy `@internal remote_ip` matcher + `handle`/`handle`, 403 otherwise) because the page shows internal hostnames/IPs. Neither this command nor `syncProxyLive` touches that block; they only write `index.html` and the managed proxy section.

### Opt-in and skip rules

Checks run in this order:

1. Driver manages no proxy (`proxyDriver: 'none'`, `!managesProxy(driver)`): the standalone command throws `NO_PROXY_STATUS_PAGE_ERROR`, even if `statusPagePath` is set.
2. Managed driver whose `statusPage` is `null` (NPM, HAProxy, Traefik): throws `statusPageUnsupportedError(id)`; remedy is clearing `statusPagePath` or choosing a driver that serves one.
3. `statusPagePath` unset: throws, naming the `set-config statusPagePath </absolute/path> --apply` fix.

`statusPageSkipReason(inventory)` (exported) is the one place the two automated callers (`syncProxyLive`, `migrate-guest`'s post-move push) decide whether to render. It returns `{ message, level }` in the same order: the `none` line (`info`); the managed-but-no-status-page line (`warn` if `statusPagePath` is set, since the setting is being ignored, else `info`); `statusPagePathSkipMessage()` when unset (`info`); or `null` to render. Callers pass a non-null result to `logStatusPageSkip` instead of checking inline.

### Content

Two fetched-fresh, HTML-escaped `<pre>` blocks:

- A YAML snapshot of the current inventory: `src/cli.ts` calls `loadInventory` then the `yaml` package's `stringify` and passes the string in, since `bellhop.db` has no text form to `cat`.
- "Deployed proxy configuration", read via the active driver's `snapshot()`. For file drivers, `configFiles()` (default `[configPath]`, from `proxyConfigPath` else the driver's `defaultConfigPath`) resolves the paths, and the failure message comes from `src/lib/proxy/file-driver.ts`.

### Who calls it

The CLI command is manual; the CLI's `sync-proxy` never calls it. The web UI's `syncProxyLive` (create-lxc/create-vm/install-app apply with Subdomains, and the Dashboard guest PATCH) runs `sync-proxy` then `render-status-page` on every web-driven subdomain change, so they never drift, unless the skip rules apply. `migrate-guest`'s post-move push follows the same skip rules.
