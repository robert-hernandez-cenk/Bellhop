# Implementation Plan: One TLS source setting, independent of the proxy driver

**Branch**: `issue-72-tls-source-setting` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/072-tls-source-setting/spec.md`

## Summary

Replace the per-driver TLS settings (`proxyCaddyTls`, the reserved
`proxyCertResolver: none`, the `usesCaddyTls`/`usesSharedCertificate` hints
and the `acmeDns01ViaCloudflare` capability) with one deployment-wide
`tlsSource` setting plus `acmeDnsProvider`. Each driver declares the sources
it supports and its own default (so an unset setting keeps today's output);
`runSyncProxy` refuses an unsupported combination; renderers switch on the
resolved source; the Cloudflare prune reads the setting directly; a one-time
migration converts legacy rows; the Settings page shows TLS fields by source.
Detail: [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24

**Primary Dependencies**: zod (settings schema), better-sqlite3 (inventory), `yaml` (Traefik render, YAML import), Express (Settings API), React + Vite (web client)

**Storage**: `inventory/bellhop.db` `meta` table (settings rows)

**Testing**: `node --test` under `test/`; `FakeSSHClient`; temp SQLite fixtures; `test/web-client/*` for framework-free client logic

**Target Platform**: CLI on the operator's machine; web service; proxy hosts reached over SSH

**Project Type**: CLI + web service + React client (single repository)

**Performance Goals**: n/a (configuration rendering)

**Constraints**: byte-identical rendering for unchanged effective sources; no check on inventory load; POSIX `sh` unaffected (no new remote commands)

**Scale/Scope**: 7 drivers, ~15 source files, ~12 test files, 6 docs pages, 5 nested `CLAUDE.md` files

## Constitution Check

| Principle | Status |
|---|---|
| I. Example data only | Pass — fixtures and docs use `example.com` and certbot example paths |
| II. Code quality | Pass — one shared place for the support check (`src/lib/proxy/tls.ts`) and the legacy conversion (`legacy-tls.ts`); settings stay zod enums; errors name the `set-config` fix |
| III. Testing | Pass — each behavior change ships with tests; migration tested on temp DBs; no new network client (Traefik `files` hand-check noted as unverified) |
| IV. UX consistency | Pass — CLI, web, MCP share `runSyncProxy`'s refusal; Settings verified at desktop and ≤640px; docs and `CLAUDE.md` updated in the same change; screenshot regenerated |
| Single-operator assumptions | Recorded — `ACME_DNS_RESOLVERS` and Cloudflare-only DNS-01 scoped to `tlsSource: acme-dns` + `acmeDnsProvider: cloudflare` in `src/lib/proxy/CLAUDE.md` and `drivers/CLAUDE.md` |

Re-checked after Phase 1 design: no violations, no complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/072-tls-source-setting/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rendering-and-messages.md
│   └── settings-api-and-ui.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts               # TLS_SOURCES, ACME_DNS_PROVIDERS, DEFAULT_PROXY_DRIVER_ID (moved); CADDY_TLS_MODES removed
├── tls.ts               # NEW: effectiveTlsSource, acmeDnsProvider, checkTlsSource, usesCloudflareDns01
├── legacy-tls.ts        # NEW: convertLegacyTlsSettings (pure)
├── driver.ts            # capabilities.tlsSources/defaultTlsSource; drop acmeDns01ViaCloudflare, usesCaddyTls, usesSharedCertificate
├── routes.ts            # ProxyContext.tlsSource/acmeDnsProvider; buildProxyContext(inventory, driver); drop caddyTlsMode, NO_CERT_RESOLVER
├── index.ts             # re-export DEFAULT_PROXY_DRIVER_ID
├── file-driver.ts       # pass-through of removed hints dropped
├── caddy-json.ts        # renderTlsObjects / writesPolicy by tlsSource
└── drivers/{caddy,caddy-api,traefik,nginx,nginx-proxy-manager,haproxy,none}.ts
src/lib/inventory.ts     # SettingsSchema keys; migrateLegacyTlsSettings in openInventoryDb
src/commands/networking/{sync-proxy,convert-caddyfile}.ts   # checkTlsSource, buildProxyContext(…, driver)
src/commands/maintenance/import-yaml-inventory.ts           # legacy conversion on YAML input
src/web/proxy-sync.ts    # prune decision + skip message
src/web/routes/settings.ts                                  # driver info + response fields
web-client/src/api/types.ts, web-client/src/lib/settings-display.ts, web-client/src/pages/SettingsPage.tsx (+ field help)
docs/configuration.md, docs/reverse-proxy/{README,caddy,caddy-api,nginx,haproxy,traefik}.md, inventory/hosts.yaml.example
src/lib/CLAUDE.md, src/lib/proxy/CLAUDE.md, src/lib/proxy/drivers/CLAUDE.md, src/commands/networking/CLAUDE.md, src/web/CLAUDE.md, web-client/CLAUDE.md
docs/images/settings-proxy-driver.png (regenerated)
test/lib/proxy/{tls,legacy-tls}.test.ts (new); existing driver, routes, index, inventory, sync-proxy, proxy-sync, settings, settings-display, set-config, file-driver tests updated
```

**Structure Decision**: Existing single-repository layout; two new small
modules under `src/lib/proxy/`, everything else edits in place.

## Implementation order

1. Foundation: `ids.ts` constants, `tls.ts`, `legacy-tls.ts`, capability fields on every driver, `ProxyContext`/`buildProxyContext` change, settings schema (US1/US2 groundwork).
2. US1 + US2: renderers by source (Caddy, admin API, Traefik incl. `files`), `checkTlsSource` in `runSyncProxy` and `convert-caddyfile`.
3. US4: migration in `openInventoryDb`, YAML import conversion.
4. US3: prune decision.
5. US5: Settings API + client + screenshot.
6. Docs and nested `CLAUDE.md` (in the commits that change the behavior they describe).

## Complexity Tracking

None.
