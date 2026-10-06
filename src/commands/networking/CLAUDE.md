# Networking commands

Scope: `sync-authentik`, OIDC credentials and adoption, `prune-acme-challenges`, `render-status-page`. Elsewhere: `sync-proxy`/`runSyncProxy` in `src/lib/proxy/CLAUDE.md`; `convert-caddyfile` in `src/lib/proxy/drivers/CLAUDE.md`; Dashboard tier/`unauthenticatedPaths` rules and the `syncProxyLive` push-live step (`sync-proxy`, `render-status-page`, `sync-authentik`, then `prune-acme-challenges`) in `src/web/CLAUDE.md`; per-guest echoes (`commitGuestEdit`), OIDC client deletion confirmation, and required `OperationDeps.cloudflare` in `src/operations/CLAUDE.md`; banners in `web-client/CLAUDE.md`.

## sync-authentik

`sync-authentik.ts`: `sync-proxy`'s Authentik counterpart for per-app gating (#80); REST-only, dry-run/`--apply`. Reconciles Proxy Providers, Applications, policy bindings, and embedded-outpost membership against every gated entry (`authGroup` names a rung).

### Slugs and naming

- Application slug = canonical subdomain `subdomains[0]`; no Authentik IDs persist to `inventory/bellhop.db`.
- The slug is also the Application's and provider's display name (#156); only the Proxy Provider's `externalHost` (`https://<slug>.<domain>`) appends the domain, as Authentik matches forward-auth requests against it.
- `toCreate`/`toRemove`/`conflicts` hold bare slugs, which `src/web/routes/dashboard.ts` compares to `subdomains[0]` to scope the conflict banner; a mismatch silently renders no banner.

### Group-ladder bindings

- Every `--apply` (#158) binds each gated Application to the entry's rung and every rung above (`rungsAtOrAbove`, `src/lib/authentik-config.ts`). `AUTHENTIK_GROUP_LADDER`: comma-separated, low to high, default `bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins`. Authentik ORs bindings (`policy_engine_mode: any`), so the top rung is effectively admin-only.
- Creates missing wanted bindings, deletes unwanted on-ladder group ones; off-ladder group (hand-added) and policy-/user-backed bindings are untouched.
- A needed rung missing in Authentik goes in `missingRungs`, never auto-created (that would hide a ladder typo).
- An off-ladder `authGroup` entry is skipped entirely and reported in `offLadder`, not a `loadInventory` error (`validateInventory` runs on every load; a ladder edit must never make a saved inventory unloadable).

### Application existence and ownership (#154)

- Clearing a gate deletes its Provider/Application (and outpost entry) next `--apply`.
- Ownership (exported `ownedProviderKind`) needs a slug matching an inventory subdomain plus a proxy provider (owned by slug alone, so pre-marker Applications still count), or an OAuth2 provider carrying `meta_publisher: 'bellhop'` (`BELLHOP_META_PUBLISHER`, so a hand-made OpenID client sharing a slug never matches). Provider-less or non-inventory-slug Applications (e.g. the `homelab.example.com` dashboard's, or `qbittorrent` fronting an external seedbox via a hand-authored Caddy block) are untouched.
- A gated entry whose slug an unowned Application holds (Authentik's unique-slug constraint) is skipped and listed in `conflicts` (CLI prints it; `syncProxyLive` returns it inventory-wide as `authentikConflicts`), never aborting an unrelated Dashboard edit.
- Known limitation: a gated entry's subdomain rename leaves the old-slug Application behind (now outside ownership) while a new one is created; delete it by hand. See `candidateEntries`'s comment.

### Native OIDC gating (#1)

When `effectiveAuth()` is `'oidc'`: an OAuth2/OpenID Provider + Application instead, same rung-and-above bindings via exported `planBindingChanges` (shared with `adopt-oidc-client.ts`), never on the outpost.

Provider listing:

- `listOAuth2Providers` already drops proxy providers (Authentik 2026.8 returns them from the OAuth2 endpoint; see `src/web/CLAUDE.md`), so `ownedProviderKind`'s `proxyProviderIds`/`oauth2ProviderIds` are checked independently (proxy first).
- OAuth2 providers are listed every run (ownership). Once any entry is OIDC, `authentikApiToken` needs read/write on OAuth2/OpenID Providers, read on certificate-keypairs and scope/property mappings, update on Applications ("OIDC mode" in `docs/authentik.md`).
- `listOAuth2ProvidersForRun`: with no `authMode: 'oidc'` candidate (gated or not) a failed listing counts as empty (forward-only deployments with older tokens keep working); otherwise it propagates.

Client shape:

- Confidential. `OIDC_GRANT_TYPES` (authorization-code + refresh-token) must be sent on create, else Authentik stores `[]` and rejects every authorize request.
- Signed with the keypair named `AUTHENTIK_OIDC_SIGNING_KEY_NAME` (default `'authentik Self-signed Certificate'`, on every stock install; single-operator default), via `getSigningKeyId`.
- A new client releases `openid`/`profile`/`email` (`OIDC_SCOPE_MAPPINGS`), found by Authentik's stable `managed` identifier, not the editable name.
- `resolveOidcInstanceSettings`: one `listScopeMappings()` (`?page_size=500`) per run gives the built-in ids and `scopeNameById` (id -> `scope_name`). Truncated-page guards here and in `listPolicyBindings`/`listOAuth2Providers` read `pagination.count` (no top-level `count`, #16).
- Key and mappings resolve once per run, only if some entry has redirect URIs; either failing skips every such entry (`missing-signing-key`/`missing-scope-mapping` in `oidcSkipped`) while forward entries carry on.
- No `oidcRedirectUris`: skipped (`missing-redirect-uris`), never PATCHed to an empty list (would lock out a working login).

Drift (`diffOAuth2Settings`):

- Compares redirect URIs (set of `(matchingMode, url)` pairs, from exported `clientRedirectUris(entry)`: web + mobile, deduped, web first), grant types, scope mappings, signing key, client type; returns drifted names plus a patch of only those. `oidcUpdates` reports fixes (e.g. `~ slug: redirect_uris, signing_key`).
- Scope mappings (owned client, `adopt-oidc-client`) compare by scope name (#16): a required scope is covered by its built-in id or any attached same-scope-name mapping; others ignored. Only an uncovered one is `property_mappings` drift, patched by appending the built-in to the attached ids (order kept). A custom mapping survives (e.g. a custom `email` deriving `email_verified`; the built-in always reports `false`), but a built-in swapped for a same-scope-name one is never restored.
- Fail-safes: an attached id absent from the listing leaves `property_mappings` alone entirely; an unlisted built-in id counts as covered only if attached.
- A reused leftover (`planProviderName`'s `reuseId`) may be hand-made, so `diffOAuth2Settings(..., 'exact')` sets exactly the three built-ins.
- `DesiredOAuth2Settings` has no credentials, so nothing can rotate `client_id`/`client_secret`.

### Mode switches (`ModeSwitch`)

- Only the provider is swapped; the Application (pk, slug, bindings, so its tier) is kept. Provider names are unique across all kinds (verified 2026.8) and both are named after the slug, so `planProviderName` renames the outgoing one to `'<slug> (replaced)'` (`REPLACED_PROVIDER_SUFFIX`), creates the new one, repoints the Application (clearing `meta_publisher` on oidc -> forward, setting it on forward -> oidc), then deletes the renamed one.
- A proxy-provider rename re-sends its `mode` (and `internal_host` in `proxy` mode): 2026.8 400s a name-only PATCH, and a fixed mode would convert a hand-made provider. `renameProxyProvider` takes the whole `AuthentikProxyProvider`.
- Known limitation: failing between rename and repoint strands `'<slug> (replaced)'`; switching back is skipped as `provider-name-taken` (naming it) until it's hand-deleted. A correctly named unused leftover self-heals (`planProviderName` reuses it: `reuseId`/`orphan`).
- `forwardSkipped` mirrors `oidcSkipped`: a new forward Application or oidc -> forward switch whose name an unrelated provider holds is reported (`provider-name-taken`), not failed.

### Outpost membership

Every `--apply`: each owned, desired, Proxy-backed Application's provider is on the embedded outpost, a retired one (removed or now OIDC) is not; partial failures self-heal and the dry run previews it (`outpostChanges`). Hand-added providers untouched.

### adoptableConflicts

The `conflicts` whose unowned Application has any OAuth2 provider (adoptable); Proxy- or provider-less ones stay `resolve-by-hand`. `conflictExplanation(slug, result)` alone picks the wording (`formatSyncAuthentik`, `syncProxyLive` job-log warnings, delete-guest's pre-removal sync).

### Post-apply discovery check

After a real `--apply`, each OIDC entry with an owned client has `<issuer>/.well-known/openid-configuration` checked for 200 JSON (`checkOidcDiscovery`, `DISCOVERY_TIMEOUT_MS` 10s). Never rolled back: the client is right; the cause is usually network.

`syncAuthentikFailed` (CLI non-zero exit), `--apply` only: a failed discovery check, an instance-wide `missing-signing-key`/`missing-scope-mapping` skip, or `mobileConsent.error`. Never a dry run, a conflict, or one entry's incomplete config (`missing-redirect-uris`, `provider-name-taken`). Push-live returns discovery failures as a warning, not a failed save.

### Mobile consent step (#22)

With any `oidcMobileRedirectUris` in effect, a one-click consent step on the `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` flow: consent stage `MOBILE_CONSENT_STAGE_NAME` (`'bellhop-mobile-app-consent'`, `mode: 'always_require'`); its flow binding (`evaluate_on_plan: false`, `re_evaluate_policies: true`, order `10`, like the stock explicit-consent flow); expression policy `MOBILE_CONSENT_POLICY_NAME` (`'bellhop-consent-on-mobile-redirect'`); and its policy binding on the stage binding (`failure_result: false`).

- Input `mobileUriSet(desired)`: sorted, deduped union over every desired OIDC candidate (gated, has subdomains, `effectiveAuth() === 'oidc'`) whatever its ladder/conflict/skip state, since a URI without a live client can't be a real `redirect_uri`; keeps the policy stable while unrelated problems are fixed.
- `renderMobileConsentExpression(uris)`: first line `MOBILE_CONSENT_MARKER`, a sorted `MOBILE_REDIRECT_URIS` set literal (`pythonStringLiteral`, escaping non-printable-ASCII by code point, not UTF-16 unit, so a surrogate pair isn't two never-matching lone surrogates), then a check of `request.context.get("goauthentik.io/providers/oauth2/params").redirect_uri`. Fails closed: missing `params` (`None`) or a throw under `failure_result: false` skips the stage; neither blocks a login.
- Ownership: a policy needs an expression starting with `MOBILE_CONSENT_MARKER`, a stage must be a consent stage. A same-named object failing this goes in `mobileConsent.conflicts` and skips the whole consent reconcile that run, without failing it.
- Order: create stage -> policy -> binding -> policy binding; delete (set empty) in reverse; only owned objects, so hand-added bindings/policies on the stage binding survive.
- `applyMobileConsent` rolls back a just-created stage binding whose policy binding fails (it would gate every login on the flow); a pre-existing one (repair) stays.
- Any run changing the binding or policy (rollback included, even if a later step failed) clears the flow cache (`POST /api/v3/flows/instances/cache_clear/`); a stage-only `mode` repair needn't (read at execution).
- Isolation: own `try/catch` after group bindings, before discovery; a throw becomes `mobileConsent.error` (plus a hint naming `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` and the token's stage/policy/flow permissions) and the run completes.
- Empty URI set: a failure merely reading the four objects or resolving the flow is swallowed as nothing-to-do (like `listOAuth2ProvidersForRun`), so an older token without mobile URLs sees no new error; owned leftovers from an under-permissioned run then stay, which that combination can't have created.
- Limits: only the `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` flow gets the step (a client on another flow gets mobile `redirect_uris` only); `adopt-oidc-client` writes `redirect_uris` (web + mobile) but not the step, which the next `sync-authentik` or Dashboard edit creates.

### What syncProxyLive returns

The guest PATCH runs outside any job, where a `logWarn` reaches only stderr (job callers get it via `withCapturedConsole`), so `SyncProxyLiveResult` also returns `authentikConflicts`, `authentikAdoptableConflicts`, `authentikOidcSkipped`, `authentikForwardSkipped`, discovery failures, and `authentikMobileConsentProblems` (`mobileConsent.conflicts`, then `.error`, also `logWarn`ed).

### Live-verified Authentik 2026.8 API quirks

- `GET /api/v3/policies/all/` ignores `name`; `findPolicyByName` matches client-side.
- `GET /api/v3/flows/bindings/` ignores `target__slug` (`target=<pk>` works): list by flow pk, filter to the owned stage's `stageId` in code.
- `GET /api/v3/policies/bindings/?target=<pk>` on a flow-stage binding needs its `policybindingmodel_ptr_id` (plain `pk`: `"Select a valid choice"`), yet results report `target` as the plain `pk`; so listed bindings match `AuthentikFlowStageBinding.id` or `.policyBindingModelId`, and new ones use `target: policyBindingModelId` (as the admin UI does).

## OIDC credentials and adoption (#1)

`oidc-credentials.ts`, `adopt-oidc-client.ts`, `src/web/routes/oidc.ts`; always admin-gated.

### oidc-credentials

- CLI `oidc-credentials <entry>` (read-only) and `GET /api/oidc/:entry/credentials` (router-wide `requireAdminGroup`, `Cache-Control: no-store`) refuse an entry whose `effectiveAuth()` isn't `'oidc'`, find the owned client (`ownedProviderKind`), and return issuer, client ID, and secret, read live (`getOAuth2Credentials`); the secret never enters inventory, jobs/logs, or MCP responses.
- MCP `get_oidc_client` (`src/mcp/build-server.ts`) calls only `runOidcClientInfo`, which drops the secret before MCP code holds it; `secretAvailableFrom` names the Dashboard or CLI.
- `OidcCredentials.tsx` uses the web route; non-admins (even via impersonation: `isAdminUser` reads overlaid groups) get a "OIDC (credentials visible to admins)" note.

### configure-web-login (#69)

- CLI-only `configure-web-login <entry> [--apply]` (`configure-web-login.ts`): `runOidcCredentials` for issuer/client ID/secret, the entry's `oidcRedirectUris` URL whose pathname is exactly `/auth/callback`, then the settings write path (non-secrets) and `writeSecret` (secret); every check precedes the first write. Its result type has no secret field; an env-pinned key is stored with `warnIfEnvPinned` (shared with `set-config`). `OIDC_SCOPE_MAPPINGS` includes `scope-offline_access` so Bellhop's own client gets a refresh token.

### adopt-oidc-client

- CLI `adopt-oidc-client <entry> [--apply]`, web `POST /api/oidc/:entry/adopt/preview`/`/apply` (`AdoptOidcClientButton`), and MCP `adopt_oidc_client` (`fleetWide: true`: `entry` may be a host or external site) all use `runAdoptOidcClient`.
- For one entry, does a sync's three steps: set `meta_publisher: 'bellhop'`, PATCH drift via `diffOAuth2Settings` (never credentials), reconcile bindings via `planBindingChanges`. `formatAdoptOidcClient` mirrors `formatSyncAuthentik`.
- Refuses a non-OIDC-effective entry, an already-owned Application (either kind), or a non-OAuth2 one.

## prune-acme-challenges (#162)

`prune-acme-challenges.ts` deletes stale `_acme-challenge` TXT records in the `domain`'s Cloudflare zone left by ACME DNS-01 through Cloudflare (`tlsSource: acme-dns`) (aborted issuance, mid-challenge restart, removed/renamed subdomain). Dry-run/`--apply`; a failed delete is reported, the rest proceed (CLI exit 1).

### Ownership: age-based and zone-wide

Deletable: name `_acme-challenge.<domain>` or `_acme-challenge.<labels>.<domain>` (case-insensitive), type `TXT`, `modifiedOn` older than 24h (`STALE_AFTER_MS`, fixed). Inventory scoping would miss a removed/renamed subdomain's record (the main case); age keeps it safe, as a challenge record matters only for minutes. Never deleted: a `CNAME` at `_acme-challenge` (DNS-01 delegation), an unparseable `modifiedOn`, a Cloudflare-managed record (`meta.read_only`/`meta.auto_added`, e.g. Universal/Advanced cert validation TXT; `CloudflareDnsRecord.managedByCloudflare`). All TXT records are listed with no server-side name filter (none could be verified live); the command does all name matching.

### Client and credential

- `CloudflareClient` (`src/lib/cloudflare-client.ts`): REST-only, real/unconfigured null-object like `AuthentikClient`; `buildCloudflareClient()` re-reads config per call (`src/lib/CLAUDE.md`, Settings store). Each `RealCloudflareClient` request has `AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS)` (10s), throwing on timeout.
- Credential: `cloudflareDnsApiToken` secret (Zone:Read + DNS:Edit, this use only), overridden by `CLOUDFLARE_DNS_API_TOKEN`; `data/cloudflare-api.env` is just a one-time import source (an override while present). Not `data/cloudflare.env` (`cloudflare-ddns-lxc` answer file, unread by `src/`) nor Caddy/DDNS's `CLOUDFLARE_API_TOKEN`, so each token is revocable alone.

### When it runs

- Last step of `syncProxyLive` (`src/web/proxy-sync.ts`), never failing it. Under `proxyDriver: none` (`!managesProxy`) it logs `PRUNE_ACME_NO_PROXY_SKIP_MESSAGE` (`prune-acme-challenges: skipped, proxyDriver is 'none' (Bellhop manages no reverse proxy, so its challenge records are not Bellhop's)`) and never touches Cloudflare, whatever `tlsSource` is stored: any challenge records belong to the operator's own proxy. Otherwise, if `usesCloudflareDns01(inventory, getDriver(inventory))` (`src/lib/proxy/tls.ts`: a managed driver that supports the effective `tlsSource`, which is `acme-dns`, and `acmeDnsProvider` is `cloudflare`) is false it logs one skip line (`pruneAcmeTlsSkipMessage`: `prune-acme-challenges: skipped, the TLS source is '<x>' (only acme-dns with the cloudflare DNS provider leaves challenge records)`) and skips Cloudflare. The decision is the TLS source alone, never the driver's identity (#72; before it, Caddy answered for `acme-dns` and Traefik for any named resolver, so Traefik under `acme-http` no longer prunes); an unconfigured client logs its own; a throw becomes a `logWarn`. Nothing goes into `SyncProxyLiveResult`.
- It is always false for nginx, Nginx Proxy Manager, HAProxy, `none` (even with `acme-dns` stored: `usesCloudflareDns01` checks `managesProxy` and `checkTlsSource` first); for Caddy unless the effective `tlsSource` is `acme-dns`; for Traefik when it is `files` or `external` (#72).
- Only guest-edit and create/install/delete-guest paths prune; `sync-proxy`, `render-status-page`, `migrate-guest` (CLI, web, MCP) call `runSyncProxy`/`runRenderStatusPage` directly.

## render-status-page

`render-status-page.ts` writes a static page to `statusPagePath` (#124) on the `proxy: true` entry: the root of a hand-authored `caddy.example.com` `file_server` block, outside any managed section and LAN-restricted by hand (`@internal remote_ip` + `handle`/`handle`, else 403) since it shows internal hostnames/IPs. Only `index.html` and the managed proxy section are ever written, never that block.

### Opt-in and skip rules

The standalone command throws, in order: no managed proxy (`proxyDriver: 'none'`, `!managesProxy(driver)`) -> `NO_PROXY_STATUS_PAGE_ERROR`, even with `statusPagePath` set; `statusPage: null` driver (NPM, HAProxy, Traefik) -> `statusPageUnsupportedError(id)` (clear `statusPagePath` or switch driver); `statusPagePath` unset -> names `set-config statusPagePath </absolute/path> --apply`.

Automated callers (`syncProxyLive`, `migrate-guest`'s post-move push) use exported `statusPageSkipReason(inventory)`: `{ message, level }` in the same order (`none`: `info`; no status page: `warn` if `statusPagePath` is set, as it's ignored, else `info`; unset: `statusPagePathSkipMessage()`, `info`) or `null` to render; non-null goes to `logStatusPageSkip`.

### Content and callers

Two fresh, HTML-escaped `<pre>` blocks: a YAML inventory snapshot (`src/cli.ts`: `loadInventory` then `yaml`'s `stringify`; `bellhop.db` has no text form) and "Deployed proxy configuration" via the driver's `snapshot()` (file drivers: `configFiles()`, default `[configPath]` = `proxyConfigPath` else `defaultConfigPath`; failure message from `src/lib/proxy/file-driver.ts`).

Manual from the CLI (CLI `sync-proxy` never calls it); `syncProxyLive` runs it right after `sync-proxy` on every web-driven subdomain change (create-lxc/create-vm/install-app with Subdomains, Dashboard guest PATCH) so they never drift.
