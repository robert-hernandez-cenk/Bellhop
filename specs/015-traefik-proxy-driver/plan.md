# Implementation Plan: Traefik Proxy Driver

**Branch**: `issue-35-traefik-proxy-driver` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-traefik-proxy-driver/spec.md`

## Summary

Add a `traefik` proxy driver built on `fileDriver`. It renders one
Bellhop-owned Traefik file-provider YAML file (routers, services,
middlewares, a servers transport, and a content-derived generation marker)
and replaces it atomically on the proxy host. Traefik hot-reloads, so there
is no reload command. When the new `proxyApiUrl` setting is set, the apply
script's validate step polls Traefik's API until the marker appears and
then requires every Bellhop router to be `enabled`; otherwise the existing
restore trap puts the previous file back. A second new setting,
`proxyCertResolver` (default `cloudflare`), names the certificate resolver.
`fileDriver` gains a nullable validate/reload command, a validate label,
access to the rendered files and inventory in the validate builder, and
atomic owned-file writes. Caddy and nginx scripts stay byte-identical.
Every Traefik behavior the design relies on was checked against a real
Traefik v3.7.13 ([research.md](research.md)).

## Technical Context

**Language/Version**: TypeScript (Node 22+/26, `--experimental-strip-types` style `.ts` imports), strict

**Primary Dependencies**: `yaml` (already a dependency) for rendering; `zod` settings schema; React web client

**Storage**: inventory SQLite `meta` table (two new optional settings keys; no schema migration: `meta` is key-value)

**Testing**: `node --test`; the executed-script tests run the generated `sh` with stubbed `curl`/`sleep` on `PATH` (the established `file-driver.test.ts` pattern); captured Traefik API fixtures in `test/fixtures/traefik/`

**Target Platform**: Proxy host running Traefik v3 with a watched file-provider directory; the apply script is POSIX `sh`

**Project Type**: CLI + web service + MCP server (single repo)

**Performance Goals**: The API check finishes within 30s of the write, and within about 2s (Traefik's default throttle) in the normal case

**Constraints**: No change to Caddy and nginx output (FR-016); no Traefik v2 support; the entry point is fixed at `websecure`

**Scale/Scope**: About 1 new driver file, `fileDriver` extensions, 2 settings, Settings page wiring, docs

## Constitution Check

| Principle | Check | Status |
| --- | --- | --- |
| I. No real data | Every example uses `example.com`/`192.0.2.x`; the captured fixtures came from a local Traefik fed example config; the `cloudflare` resolver default is a generic name, not an operator value | Pass |
| II. Code quality | Remote execution only through `fileDriver` -> `runRemote`; the script is POSIX sh; settings validated by the shared `SettingsSchema`; errors name the router or timeout and the fix | Pass |
| III. Testing | Renderer unit tests; executed-script tests with stubbed binaries (the documented `file-driver` exception, not `ssh`/`pct`); API fixtures captured from a real Traefik, not hand-written | Pass |
| IV. UX consistency | `sync-proxy` dry run previews the exact file; the same `SettingsSchema` rule for CLI/web/MCP; Settings page verified at desktop and 640px or narrower; docs and CLAUDE.md updated in the same change | Pass |

Post-design re-check: no violations, and no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/015-traefik-proxy-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/traefik-driver.md
└── tasks.md            (speckit-tasks)
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts                    # + 'traefik'
├── driver.ts                 # + usesCertResolver / usesApiUrl metadata
├── routes.ts                 # + ProxyContext.certResolver
├── file-driver.ts            # nullable validate/reload, validateLabel, validate ctx, atomic owned writes
├── index.ts                  # register traefikDriver (before none)
└── drivers/traefik.ts        # NEW: render(), marker, names, API check script
src/lib/inventory.ts          # SettingsSchema: proxyCertResolver, proxyApiUrl
src/web/routes/settings.ts    # proxyDrivers[] + usesCertResolver/usesApiUrl
web-client/src/api/types.ts
web-client/src/lib/settings-display.ts   # showCertResolverField / showApiUrlField
web-client/src/pages/SettingsPage.tsx    # two FIELDS entries + visibility
test/lib/proxy/drivers/traefik.test.ts   # NEW
test/lib/proxy/file-driver.test.ts       # nullable commands, atomic write, executed API-check cases
test/lib/proxy/index.test.ts, routes.test.ts, test/web/routes/settings.test.ts,
test/commands/set-config.test.ts, web-client lib tests
test/fixtures/traefik/*.json             # captured
docs/reverse-proxy/traefik.md            # NEW
docs/reverse-proxy/README.md, docs/configuration.md, README.md, CLAUDE.md, CONTRIBUTING.md
```

**Structure Decision**: follow the nginx driver's layout exactly: one
driver file on top of `fileDriver`, with shared behavior (atomic writes,
optional validate/reload) added to `fileDriver` rather than special-cased
in the driver.

## Implementation phases (story order)

1. **Foundation**: extend `fileDriver`/`buildFileDriverScript`, keeping
   Caddy and nginx output byte-identical (existing tests stay green). Add
   `'traefik'` to the ids, `ProxyContext.certResolver`, and the two
   settings.
2. **US1**: the renderer for ungated and OIDC routes, the backend scheme
   and insecure transport, the forwarded-port middleware, the marker,
   atomic owned file, header check, and registration.
3. **US2**: forward-auth middleware, outpost router and service, exempt
   router, and `/*` and outpost-namespace handling.
4. **US3**: the API check script, plus executed-script tests with
   stubbed `curl`/`sleep` driven by the captured fixtures.
5. **US4**: settings API metadata, Settings page fields and visibility,
   and browser checks.
6. **Docs**: `docs/reverse-proxy/traefik.md` (operator's static config,
   limits: hot reload, the resolver not being checked by the API), the
   configuration table, README, CLAUDE.md driver bullets, and
   CONTRIBUTING's fixture list.
7. **Verify**: quickstart, including loading the rendered file into a
   local Traefik.

## Single-operator assumptions

The new ones are the fixed `websecure` entry point name, the `cloudflare`
default resolver name, and the 30s load timeout. All three are documented
in the Traefik doc page and in CLAUDE.md's driver bullet.
