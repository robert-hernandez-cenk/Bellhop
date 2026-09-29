# Implementation Plan: nginx Proxy Driver

**Branch**: `issue-30-nginx-proxy-driver` | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-nginx-proxy-driver/spec.md`

## Summary

Add a second reverse-proxy driver, `nginx`, on the seam issue #10 built.
It is file-configured, so it is one `fileDriver({...})` call: a pure
`render(routes, ctx, configPath)` producing one Bellhop-owned file
(`/etc/nginx/conf.d/bellhop.conf` by default), validated with `nginx -t` and
reloaded with `systemctl reload nginx`. Backup/restore, preview-equals-apply,
snapshot, capability enforcement, and the ACME-cleanup skip all come from
existing code unchanged.

The render follows Authentik's own nginx forward-auth recipe (research R3)
and reproduces Caddy's `reverse_proxy` defaults nginx lacks (R4). Every site
uses one shared certificate (user's choice, R1), resolved into a new
required `ProxyContext.tls` from two new settings, `proxyTlsCertificate`/
`proxyTlsKey`, defaulting to certbot's layout for the inventory domain.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React 19 + Vite

**Primary Dependencies**: existing only (`zod`, `better-sqlite3`, `commander`, `express`). No new dependencies.

**Storage**: `inventory/bellhop.db` `meta` table gains two optional keys through `SETTINGS_KEYS`; no schema/SQL change.

**Testing**: `node --test`; exact-text render tests; one executed-script test under `sh` with stub `nginx`/`systemctl` (research R9); temp SQLite fixtures for settings.

**Target Platform**: Bellhop CLI/web/MCP; proxy host runs distribution-packaged nginx under systemd (Debian/Ubuntu layout), reached over SSH.

**Project Type**: CLI + web service + MCP server + web client (single repository)

**Performance Goals**: none; one SSH round trip per apply, as today.

**Constraints**: Caddy output byte-identical (FR-013; existing `caddy.test.ts` characterization); remote script stays POSIX `sh`; preview equals apply.

**Scale/Scope**: 1 new driver module + tests; ~6 edited source files; Settings page; README/CLAUDE.md.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Contract, tests, and docs use `example.com` and RFC 5737 addresses. The certificate default is derived from the operator's own inventory `domain`, not a hardcoded operator value. |
| II. Code quality | PASS | Delivery goes through the existing `fileDriver` → `runRemote`; no new transport. Settings validated by the one `SettingsSchema`. The certificate default is resolved in one place (`buildProxyContext`). New strings in the file are quoted via one helper. |
| III. Testing | PASS | Render tests per feature; the executed-script test covers `'owned'` mode restore with nginx's real commands (the #10 precedent for script execution, not mocking `ssh`/`pct`/`qm`). No third-party API fixtures involved: the Authentik recipe is configuration text, cited in research R3. |
| IV. UX consistency | PASS | Dry run by default and preview = apply, inherited from `fileDriver`. `proxyDriver nginx` and the two new settings work identically from `set-config` and the Settings page (same schema). Settings page change checked at desktop and ≤640px. README and CLAUDE.md updated. |
| Workflow | PASS | Own worktree/branch, PR to `main`. Single-operator assumptions: none added (certificate default derived from `domain`); CLAUDE.md's "Caddy is the only driver that ships" statements are updated rather than left stale. |

Post-design re-check: PASS. No new dependency, persisted secret, or remote
execution path.

## Project Structure

### Documentation (this feature)

```text
specs/009-nginx-proxy-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/nginx-config.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts               # PROXY_DRIVER_IDS += 'nginx'
├── index.ts             # register nginxDriver
├── routes.ts            # ProxyContext.tls; buildProxyContext resolves it
└── drivers/nginx.ts     # NEW  render(), nginxDriver
src/lib/inventory.ts     # SettingsSchema += proxyTlsCertificate, proxyTlsKey
web-client/src/api/types.ts, web-client/src/pages/SettingsPage.tsx   # two fields; proxyDriver help/placeholder
README.md, CLAUDE.md

test/lib/proxy/drivers/nginx.test.ts        # NEW
test/lib/proxy/routes.test.ts               # buildProxyContext tls default/override
test/lib/proxy/index.test.ts                # getDriver returns nginx; unknown id -> 'unknown-provider'
test/lib/inventory.test.ts                  # schema: nginx accepted, new keys, unknown -> 'unknown-provider'
test/commands/set-config.test.ts            # new keys; unknown id -> 'unknown-provider'
test/web/routes/settings.test.ts            # new keys; unknown id -> 'unknown-provider'
test/lib/proxy/file-driver.test.ts          # ProxyContext literals gain tls
test/web/proxy-sync.test.ts, test/commands/sync-proxy.test.ts  # nginx driver end to end (prune skipped; preview)
```

**Structure Decision**: the driver sits beside `drivers/caddy.ts`, as
issue #10 laid out. Nothing in `file-driver.ts` changes: its `'owned'` mode
already exists for exactly this driver shape.

## Implementation order

1. **Context and settings**: `ProxyContext.tls` + `buildProxyContext`
   default; `SettingsSchema` keys; switch the four "unknown driver" tests to
   `'unknown-provider'`. Caddy characterization must stay green.
2. **nginx render, ungated/OIDC** (US1): skeleton, server block, proxy
   lines, HTTPS upstream rules; register the driver; `sync-proxy`/
   `syncProxyLive` tests with `proxyDriver: 'nginx'`; executed-script test.
3. **Forward-auth** (US2): gated server additions, exempt locations with
   dedupe/quoting/`/*`, outpost and sign-in locations.
4. **Settings surface** (US3): set-config/settings-route tests for the new
   keys; Settings page fields; browser check at both widths.
5. **Docs**: README (driver, certificate prerequisite, settings), CLAUDE.md
   (driver list, `ProxyContext.tls`, settings list).
6. **Verification**: typecheck, full suite, `web:build`, quickstart §2.

## Complexity Tracking

No constitution violations to justify.
