# Implementation Plan: Caddy Admin-API Proxy Driver

**Branch**: `claude/trusting-wright-k5310i` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-caddy-admin-api-driver/spec.md`

## Summary

Add a fourth registered driver, `caddy-api`, that reconciles inventory
routes against Caddy's live JSON configuration through its admin API,
reached with `curl` on the proxy host via `runRemote`. It is the first
driver not built on `fileDriver`: `plan()` reads `GET /config/` and its
`Etag`, removes every `bellhop-`-tagged object, prepends freshly rendered
ones, and diffs the result. `apply()` writes the whole configuration with one
conditional `PATCH /config/` (R2), so a write is atomic and a concurrent
change is refused. Route JSON is rendered in TypeScript and pinned by a
captured `caddy adapt` fixture of the file-based driver's characterization
block, so both Caddy drivers provably serve the same thing (R1). A
one-time CLI command, `convert-caddyfile`, turns an existing Caddyfile into
the starting configuration using Caddy's own adapter (R7).

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React 19 + Vite

**Primary Dependencies**: existing only (`zod`, `commander`, `express`). No new dependencies.

**Storage**: none new. `proxyDriver` gains the value `caddy-api` through `PROXY_DRIVER_IDS`.

**Testing**: `node --test`; `FakeSSHClient` answering with real captured admin API responses; one adapter-parity fixture captured from Caddy v2.10.2 (example data only); a manual end-to-end run against a real local Caddy (quickstart).

**Target Platform**: proxy host (a Proxmox host or guest) runs Caddy 2.6+ under systemd with `curl` installed, reached over SSH.

**Project Type**: CLI + web service + MCP server + web client (single repository)

**Performance Goals**: two remote round trips per apply (read, write), one per dry run. No change for other drivers.

**Constraints**: preview equals apply; the file-based Caddy driver stays byte-identical (the existing characterization test); remote commands are POSIX `sh`; one `sh -c` argument ≤ 128 KiB on a guest proxy host (R3, documented).

**Scale/Scope**: 3 new source modules, 1 new command, ~8 edited files, Settings page, one new docs page.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Fixtures are real Caddy output from example inputs (`example.com`, RFC 5737 addresses). The admin address `localhost:2019` is Caddy's own default, not an operator value. |
| II. Code quality | PASS | All remote calls go through `runRemote`, and the commands are POSIX `sh`. The admin API's responses are parsed with `zod`. Ownership, placement, and conflict rules live in one pure planner (`caddy-json.ts`) shared by the driver and the conversion command. Errors name the host and the fix (contract). |
| III. Testing | PASS | Pure-planner and renderer unit tests. Driver and command tests use `FakeSSHClient` with captured responses. The adapter parity fixture is a real capture. `Ssh2SSHClient` is unchanged. The generated `sh` is verified manually against a real Caddy and recorded in the PR. |
| IV. UX consistency | PASS | Dry run by default; the preview carries the exact objects written. `sync-proxy` works the same from the CLI, web, and MCP through the existing driver seam. `convert-caddyfile` is CLI-only and reuses `--apply`. The Settings page hides the config path for this driver and is checked at desktop and ≤640px. Docs: a new `docs/reverse-proxy/caddy-api.md`, the index, `docs/commands.md`, and `CLAUDE.md`. |
| Workflow | PASS with note | The session's assigned branch stands in for a worktree (cloud session). Single-operator assumptions recorded in `CLAUDE.md`: the fixed admin address, systemd with the packaged `caddy.service` name, and the Cloudflare DNS-01 issuance shared with the Caddy driver. |

Post-design re-check: PASS. No new dependency, persisted secret, or
transport. No interface change remains: the nullable `configPath` for a
driver without a file arrived from issue #31 first (research R8).

## Project Structure

### Documentation (this feature)

```text
specs/015-caddy-admin-api-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/commands-and-messages.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts                 # PROXY_DRIVER_IDS += 'caddy-api'
├── index.ts               # register caddyApiDriver (after caddy)
├── caddy-json.ts          # NEW pure: renderRoute/renderTlsPolicy, planCaddyConfig, formatPreview
├── caddy-admin.ts         # NEW remote: readCaddyConfig, writeCaddyConfig, command builders, response parsing
└── drivers/caddy-api.ts   # NEW caddyApiDriver (plan/apply/snapshot)

src/commands/networking/convert-caddyfile.ts   # NEW runConvertCaddyfile, formatConvertCaddyfile
src/cli.ts                                      # convert-caddyfile command
src/lib/proxy/drivers/caddy.ts                  # export shared literals (output unchanged)

test/fixtures/caddy/                            # NEW captured Caddy v2.10.2 output
├── characterization-adapted.json               # caddy adapt of caddy.test.ts EXPECTED_LINES
├── get-config-empty.txt                        # GET /config/ headers+body, null config
├── get-config-routes.txt                       # GET /config/ with a hand-authored route
├── patch-412.txt / patch-500.txt               # write failures
test/lib/proxy/caddy-json.test.ts               # NEW parity + planner
test/lib/proxy/caddy-admin.test.ts              # NEW parsing + command text
test/lib/proxy/drivers/caddy-api.test.ts        # NEW driver via FakeSSHClient
test/commands/convert-caddyfile.test.ts         # NEW
test/lib/proxy/index.test.ts, test/web/routes/settings*.test.ts,
test/web-client/settings-display*.test.ts       # extended

docs/reverse-proxy/caddy-api.md  # NEW;  docs/reverse-proxy/README.md, docs/commands.md,
docs/configuration.md, CLAUDE.md # updated
```

**Structure Decision**: follows issue #10's layout: driver-specific code in
`src/lib/proxy/drivers/`, shared infrastructure beside it. JSON rendering
and planning are kept pure and separate from the remote calls so the
conversion command reuses both without going through the driver interface.

## Test map

| Requirement | Test |
| --- | --- |
| FR-001 | `index.test.ts`: registered and listed; the default is still `caddy`; `caddy.test.ts` is unchanged |
| FR-002, FR-011 | `caddy-admin.test.ts`: command text, exit 4, curl failure, non-200 |
| FR-003, SC-003 | `caddy-api.test.ts`: preview lists changes; the payload config is exactly what the PATCH body carries; a no-change run sends no write |
| FR-004, FR-005, SC-004 | `caddy-api.test.ts`: 500 and 412 captures produce the contract messages |
| FR-006, FR-007, SC-002 | `caddy-json.test.ts`: untagged objects kept in order; conflicts by route and by policy; wildcard not a conflict; the conflicting route is omitted; apply throws after writing |
| FR-008, SC-001 | `caddy-json.test.ts`: per-host deep-equal with `characterization-adapted.json`, and the TLS policy too |
| FR-009 | `index.test.ts` capabilities; the existing proxy-sync prune gate |
| FR-010, SC-005 | `caddy-api.test.ts`: exit 3 gives the contract error, for both the dry run and apply, and no write is sent |
| FR-012, SC-006 | `sync-proxy`/`proxy-sync` tests with `proxyDriver: 'caddy-api'` |
| FR-013 | `caddy-api.test.ts`: the snapshot pretty-prints and works with an invalid inventory |
| FR-014 | settings route and `settings-display` tests |
| FR-015 | `convert-caddyfile.test.ts` |
| FR-016, FR-017 | docs pages; `test/docs/links.test.ts` |

## Complexity Tracking

No violations.
