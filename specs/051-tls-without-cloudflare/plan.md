# Implementation Plan: TLS Without Cloudflare

**Branch**: `issue-51-tls-without-cloudflare` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/051-tls-without-cloudflare/spec.md`

## Summary

Add a `proxyCaddyTls` setting (`cloudflare` default, `letsencrypt`, `internal`,
`files`) read by both Caddy drivers; let Traefik's `proxyCertResolver` take the
reserved value `none`; turn the driver capability that gates the Cloudflare
`_acme-challenge` prune into a function of the inventory; surface the new
setting on the Settings page; and document a non-Cloudflare Let's Encrypt route
and a self-signed route for every driver. The admin-API driver's JSON for each
mode is pinned to real Caddy v2.10.2 adapter captures (research R1-R3).

## Technical Context

**Language/Version**: TypeScript (strict), Node (CI matrix)

**Primary Dependencies**: zod, Express, React (web-client); existing `fileDriver`, `caddy-json.ts` planner

**Storage**: `inventory/bellhop.db` `meta` table (one new key, no migration)

**Testing**: `node --test` via `npm test`; fixtures captured from a real Caddy adapter

**Target Platform**: Bellhop CLI / web service; proxies on Linux hosts

**Project Type**: CLI + web service + web client

**Performance Goals**: n/a (render-time only)

**Constraints**: unset setting must render byte-identical to today (SC-002)

**Scale/Scope**: 2 drivers changed in code, 1 driver tweaked, 7 doc pages, Settings page

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. No real data**: fixtures captured from a local Caddy with example data
  only (`example.com`, RFC 5737 addresses); default paths are derived from the
  inventory domain, not hardcoded. ✅
- **II. Code quality**: no new remote-execution path; the new setting validated
  by `SettingsSchema` (zod); failures go through existing explicit paths;
  shared mode resolution lives once in `routes.ts`. ✅
- **III. Testing**: TDD per story; parity against captured adapter output (not
  hand-written JSON); temp inventories only. ✅
- **IV. UX consistency**: `set-config` and Settings PATCH share
  `SettingsSchema`; dry-run preview equals apply (unchanged mechanism); the
  Settings page is verified at desktop and ≤640px; docs and CLAUDE.md updated in
  the same change. The single-operator assumption (hardcoded Cloudflare DNS-01)
  is recorded as relaxed. ✅

Post-design re-check: unchanged, all pass. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/051-tls-without-cloudflare/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/rendering-and-settings.md
└── tasks.md
```

### Source Code (repository root)

```text
src/lib/inventory.ts                    # SettingsSchema: proxyCaddyTls
src/lib/proxy/routes.ts                 # CaddyTlsMode, caddyTlsMode(), ProxyContext.caddyTls
src/lib/proxy/driver.ts                 # capability -> function; usesCaddyTls
src/lib/proxy/drivers/caddy.ts          # per-mode TLS clause
src/lib/proxy/caddy-json.ts             # per-mode TLS objects + reconcile + preview
src/lib/proxy/drivers/caddy-api.ts      # flag + capability
src/lib/proxy/drivers/traefik.ts        # NO_CERT_RESOLVER -> tls: {}
src/lib/proxy/drivers/{nginx,nginx-proxy-manager,haproxy,none}.ts  # capability () => false
src/web/proxy-sync.ts                   # prune gate calls the capability
src/web/routes/settings.ts              # caddyTlsModes, defaultCaddyTls, usesCaddyTls
web-client/src/api/types.ts
web-client/src/lib/settings-display.ts  # showCaddyTlsField, showTlsFields rule
web-client/src/pages/SettingsPage.tsx   # Caddy TLS <select>
test/fixtures/caddy/tls-*-adapted.json  # captured (research R1)
test/lib/proxy/{drivers/caddy,caddy-json,drivers/traefik,driver,index}.test.ts
test/web/proxy-sync.test.ts, test/web/routes/settings.test.ts,
test/commands/set-config.test.ts, test/lib/inventory.test.ts,
web-client settings-display test
docs/reverse-proxy/*.md, docs/configuration.md, inventory/hosts.yaml.example,
CLAUDE.md, CONTRIBUTING.md (if it restates driver rules), specs/006-reverse-proxy-driver/spec.md
```

**Structure Decision**: existing single repository layout; no new modules
beyond functions inside the files above.

## Complexity Tracking

None.
