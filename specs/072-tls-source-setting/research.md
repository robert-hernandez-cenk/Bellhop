# Research: One TLS source setting, independent of the proxy driver (#72)

No `NEEDS CLARIFICATION` items remained after the spec; each entry below
records a design decision made while reading the existing code.

## R1. Unset `tlsSource` resolves per driver, not globally

- **Decision**: Each driver declares `defaultTlsSource`; an unset
  `tlsSource` resolves to the active driver's default
  (`effectiveTlsSource`).
- **Rationale**: Today an unset deployment gets Cloudflare DNS-01 on Caddy
  and Traefik, a shared certificate pair on nginx, HTTP-01 through NPM on
  Nginx Proxy Manager, and operator-owned TLS on HAProxy. One global default
  (`acme-dns`) would make every unset nginx/NPM/HAProxy deployment fail the
  new support check, which breaks the byte-identical requirement (FR-007).
  A per-driver default also means switching drivers with `tlsSource` unset
  can never trip the check.
- **Alternatives**: a global default plus a migration that always writes an
  explicit `tlsSource` (rejected: a fresh install or a later driver switch
  would still need a per-driver answer); a global default of `external`
  (rejected: Caddy would stop obtaining certificates).

## R2. Migration only converts the value the active driver read

- **Decision**: `convertLegacyTlsSettings` (pure, in
  `src/lib/proxy/legacy-tls.ts`) takes the raw `proxyDriver`,
  `proxyCaddyTls`, `proxyCertResolver` and `tlsSource` strings and returns
  the `tlsSource` to write (if any) and the keys to delete. The active
  driver is `proxyDriver ?? DEFAULT_PROXY_DRIVER_ID`.
  - `caddy`/`caddy-api` with `proxyCaddyTls` set: `letsencrypt`→`acme-http`,
    `internal`→`internal`, `files`→`files`; `cloudflare` (the old default)
    writes no `tlsSource`: unset already means Caddy's `acme-dns`, and a
    pinned `acme-dns` would make a later switch to nginx/HAProxy/NPM be
    refused (code review).
  - `traefik` with `proxyCertResolver === 'none'`: → `external`.
  - An explicit `tlsSource` is never overwritten.
  - `proxyCaddyTls` is always deleted; `proxyCertResolver` is deleted only
    when it is `none`.
- **Rationale**: Each mapping targets the driver that read the value, and
  that driver supports every target value (Caddy supports all four;
  Traefik supports `external`), so the migration can never produce an
  unsupported combination. A stale value the active driver never read had
  no effect on output, so dropping it keeps output identical.
- **Alternatives**: convert regardless of driver (rejected: a stale
  `proxyCaddyTls: letsencrypt` under nginx would become `acme-http`, which
  nginx refuses).
- **Where it runs**: `openInventoryDb` (`src/lib/inventory.ts`), after
  `migrateCaddyToProxy`, in one transaction over the `meta` table, logging
  one `logInfo` line only when something changed (the #10/#158 precedent).
  `import-yaml-inventory` applies the same function to the parsed YAML
  object before `InventorySchema.safeParse` (zod would otherwise strip the
  unknown key silently).
- **Dependency note**: `DEFAULT_PROXY_DRIVER_ID` moves from
  `src/lib/proxy/index.ts` to the dependency-free `src/lib/proxy/ids.ts`
  (re-exported from `index.ts`), so `inventory.ts` can use the conversion
  without importing the driver registry (which would form an import cycle).

## R3. `ProxyContext` carries the effective source; `buildProxyContext` takes the driver

- **Decision**: Replace `ProxyContext.caddyTls` with `tlsSource: TlsSource`
  (already resolved against the driver) and `acmeDnsProvider:
  AcmeDnsProvider`. `buildProxyContext(inventory, driver)` takes the active
  driver; its two callers (`runSyncProxy`, `convert-caddyfile`) already
  have it (`getDriver`).
- **Rationale**: The same "never handle the unset case" precedent as
  `tls`/`certResolver`; renderers switch on one resolved value.
- **Alternatives**: calling `getDriver` inside `routes.ts` (rejected:
  `routes.ts` → `index.ts` → drivers → `routes.ts` cycle).

## R4. One support check, run where configuration is about to be produced

- **Decision**: `checkTlsSource(inventory, driver): string | null` in
  `src/lib/proxy/tls.ts`. `runSyncProxy` calls it right after the
  `managesProxy` short-circuit, before `driverDeps`/`buildRoutes`, and
  throws its message. Since `syncProxyLive` and the web/MCP `sync-proxy`
  operation both go through `runSyncProxy`, every front end gets the same
  refusal. `convert-caddyfile` calls it too (it renders Caddy routes).
- **Not run** from `validateInventory`, `loadInventory`, `set-config`, the
  Settings PATCH, or `commitGuestEdit`'s per-entry capability check: the
  TLS source is deployment-wide, not a property of the edited entry, so a
  guest edit saves and the push-live step reports the refusal as
  `proxySynced: false` (spec US2 scenario 3).
- **Message**: `tlsSource '<value>' is not supported by the '<driver>'
  proxy driver (it supports: <a>, <b>) -- to use its default
  (<driver default>), run: bellhop set-config tlsSource --unset --apply,
  or set it on the web UI's Settings page` (built with
  `settingFix('tlsSource', '--unset')`). The fix unsets rather than pins
  the default (code review): a pinned default would be refused again on
  the next driver switch.
- **Renderer backstop**: each renderer's `switch` throws a programming-error
  message on a value its driver does not support, so a missed check can
  never render a silently wrong configuration (HAProxy's forward-auth
  backstop precedent).

## R5. Traefik `files`

- **Decision**: Routers render `tls: {}` (as for `external`), and the
  document gains a top-level `tls:` section after `http:`:

  ```yaml
  tls:
    certificates:
      - certFile: /etc/letsencrypt/live/example.com/fullchain.pem
        keyFile: /etc/letsencrypt/live/example.com/privkey.pem
  ```

  It is part of both `stringify` passes, so the generation-marker hash
  covers it.
- **Rationale**: Traefik's file provider reads `tls.certificates` from
  dynamic configuration and adds each to the default store, selected by
  SNI; a router with `tls: {}` and no resolver uses it. This is Traefik's
  documented dynamic-configuration shape (v2 and v3). No `tls.stores`
  default-certificate override is written, so an operator's own default
  store stays untouched.
- **Verification limit**: There is no Traefik instance to check against in
  this run; the shape is pinned by unit tests and documented as
  hand-verification for the operator (`quickstart.md`).

## R6. Prune decision is a pure function of settings

- **Decision**: `usesCloudflareDns01(inventory, driver)` is
  `effectiveTlsSource(...) === 'acme-dns' && acmeDnsProvider(inventory) ===
  'cloudflare'`. `pruneAcmeChallengesLive` calls it in place of
  `driver.capabilities.acmeDns01ViaCloudflare(inventory)`; the skip line
  becomes `prune-acme-challenges: skipped, the TLS source is '<x>' (only
  acme-dns with the cloudflare DNS provider leaves challenge records)`.
- **Behavior change**: Traefik with a named resolver under `acme-http` no
  longer prunes (previously any named resolver did). This is the intended
  precision gain from the issue.

## R7. Settings page derives everything from `tlsSources`

- **Decision**: The driver list the Settings API returns drops
  `usesCaddyTls`/`usesSharedCertificate` and gains `tlsSources` and
  `defaultTlsSource`. The response drops `caddyTlsModes`/`defaultCaddyTls`
  and gains `acmeDnsProviders`/`defaultAcmeDnsProvider`. The client's
  `proxyFieldView(selectedId, drivers, draftOrStoredTlsSource)` resolves the
  shown source (`draft || stored || driver default`), and returns the
  dropdown options, which fields to show, and a warning string when the
  shown source is not in the driver's list. An unsupported stored value is
  kept as a dropdown option labelled `<value> (not supported)` so the
  `<select>` can still display it.
- `usesCertResolver`/`usesApiUrl`/`usesNpmApi` stay: they say which
  driver-specific settings a driver reads, not how TLS works.
- The `settings-proxy-driver.png` screenshot shows the Proxy tab and is
  regenerated (`npm run docs:screenshots`).
