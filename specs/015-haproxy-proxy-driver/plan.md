# Implementation Plan: HAProxy Proxy Driver

**Branch**: `issue-32-haproxy-proxy-driver` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-haproxy-proxy-driver/spec.md`

## Summary

Add a fifth registered reverse-proxy driver, `haproxy`, on the seam issue
#10 built. It is file-configured, so it is one `fileDriver({...})` call: a
pure `render(routes, ctx, configPath)` that returns **two** `'owned'` files
(the backends file at `configPath`, default `/etc/haproxy/bellhop.cfg`, and
`bellhop.map` beside it), validated with `haproxy -c -f
/etc/haproxy/haproxy.cfg -f <configPath>` and reloaded with `systemctl
reload haproxy`. Backup/restore of both files, ownership-header refusal,
preview-equals-apply and snapshot all come from `fileDriver` unchanged
(`configFiles` returns both paths).

The driver declares `authModes: ['oidc']`, so the existing
`checkCapabilities` refuses forward-gated routes at `sync-proxy` and at
guest-edit time without any new enforcement code — the first real driver
to exercise that path. It serves no status page and uses no shared
certificate: the operator's own frontend terminates TLS and routes through
the map file (research R1).

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React 19 + Vite

**Primary Dependencies**: existing only. No new dependencies.

**Storage**: none. `proxyDriver`'s zod enum picks up the new id from `PROXY_DRIVER_IDS`; no settings keys, no SQL change.

**Testing**: `node --test`; exact-text render tests; capability-refusal tests through `runSyncProxy` and `commitGuestEdit` with the real driver; one executed-script test under `sh` with stub `haproxy`/`systemctl` on `PATH` proving both files are restored (research R6 of spec 006). Rendered output was also checked once by hand against real `haproxy -c` 3.4.6 and 2.6 (research R2); that check is not part of `npm test`.

**Target Platform**: proxy host runs the Debian/Ubuntu HAProxy package under systemd, reached over SSH.

**Project Type**: CLI + web service + MCP server + web client (single repository)

**Performance Goals**: none; one SSH round trip per apply, as with every file driver.

**Constraints**: other drivers' output unchanged (SC-004); remote script stays POSIX `sh`; preview equals apply.

**Scale/Scope**: 1 new driver module + tests; `ids.ts`/`index.ts` registration; docs; no web-client code change (the Settings page is driven by driver metadata).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Contract, tests, docs use `example.com` and RFC 5737 addresses. No operator-specific default: the three fixed paths are distribution defaults, recorded as single-operator assumptions (R4). |
| II. Code quality | PASS | Delivery via existing `fileDriver` → `runRemote`. Backend-name derivation lives in one function. No capability logic duplicated — the driver only declares `authModes`. |
| III. Testing | PASS | Render tests, real-driver refusal tests, executed-script restore test (the #10 precedent for running a generated script, not mocking `ssh`/`pct`/`qm`). No third-party API fixture involved. |
| IV. UX consistency | PASS | Dry run default and preview = apply inherited. `proxyDriver haproxy` identical from `set-config`, Settings page and MCP (same enum). Settings page gains only a dropdown option and metadata-driven field visibility; still checked in a browser at desktop and ≤640px. Docs + CLAUDE.md updated. |
| Workflow | PASS | Own worktree/branch, PR to `main`. Single-operator assumptions added (main config path, CA bundle, reload command) are recorded in `docs/reverse-proxy/haproxy.md` and CLAUDE.md. |

Post-design re-check: PASS. No new dependency, secret, setting, or remote
execution path.

## Project Structure

### Documentation (this feature)

```text
specs/015-haproxy-proxy-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/haproxy-config.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts                    # PROXY_DRIVER_IDS += 'haproxy' (before 'none')
├── index.ts                  # register haproxyDriver between NPM and none
├── file-driver.ts            # comment only: HAProxy now ships
└── drivers/haproxy.ts        # NEW  backendName(), mapPath(), render(), haproxyDriver

docs/reverse-proxy/haproxy.md # NEW
docs/reverse-proxy/README.md, docs/configuration.md, README.md, CLAUDE.md

test/lib/proxy/drivers/haproxy.test.ts   # NEW render + executed-script tests
test/lib/proxy/index.test.ts             # PROXY_DRIVER_IDS order; getDriver('haproxy')
test/web/routes/settings.test.ts         # proxyDrivers list gains HAProxy
test/commands/sync-proxy.test.ts         # haproxy dry run/apply; forward-gated refusal
test/operations/edit-guest.test.ts       # forward-gated guest edit refused under haproxy
test/commands/render-status-page.test.ts # statusPageUnsupportedError('haproxy')
test/web/proxy-sync.test.ts              # prune skipped under haproxy
```

**Structure Decision**: the driver sits beside `drivers/nginx.ts`. Nothing
in `file-driver.ts` changes functionally: several `'owned'` files per
driver and `configFiles()` already exist for exactly this shape.

## Implementation order

1. **Registration + render, ungated/OIDC** (US1): id, registry, render of
   both files, backend naming, TLS rules; `sync-proxy` dry run/apply with
   `FakeSSHClient`; executed-script restore test; list-order tests.
2. **Capability refusal** (US2): real-driver tests for `sync-proxy` and
   `commitGuestEdit`; `unauthenticatedPaths` ignored; `proxyManual`/no
   subdomains not refused.
3. **Settings + docs** (US3): settings route test; browser check of the
   Settings page at both widths; `docs/reverse-proxy/haproxy.md`, index,
   README driver list, configuration docs, CLAUDE.md.
4. **Verification**: typecheck, full suite, `web:build`, quickstart.

## Complexity Tracking

No constitution violations to justify.
