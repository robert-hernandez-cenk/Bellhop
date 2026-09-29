# Implementation Plan: Nginx Proxy Manager Proxy Driver

**Branch**: `issue-31-nginx-proxy-manager-driver` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-nginx-proxy-manager-driver/spec.md`

## Summary

Add a fourth registered reverse-proxy driver, `nginx-proxy-manager`, the
first with no configuration file: it reconciles inventory routes against
Nginx Proxy Manager's REST "proxy hosts" over HTTP from the Bellhop host.
Each Bellhop proxy host carries an ownership marker plus the same
server-body nginx lines the nginx driver renders (shared renderer, NPM
variable names), so forward-auth, exempt paths and header parity are
identical across both nginx-based drivers. Certificates reuse an existing
covering NPM certificate or are requested from NPM (HTTP-01). The interface
gains support for a managed driver with no config path. All API shapes were
captured from a live NPM 2.16.0 (research.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22+ (repo CI matrix)

**Primary Dependencies**: global `fetch`, `zod` (response validation), `dotenv` (existing)

**Storage**: none new; NPM holds its own state; credentials in gitignored `data/nginx-proxy-manager.env`

**Testing**: `node --test` via `npm test`; fake `NpmClient` for driver logic; stubbed `fetch` over captured fixtures for `RealNpmClient`

**Target Platform**: Bellhop host (Windows service / Linux), NPM 2.x on the operator's LAN

**Project Type**: CLI + web service + MCP server (single repo)

**Performance Goals**: a sync of tens of routes completes in seconds (a few requests per changed route)

**Constraints**: 10 s per NPM request, 180 s for a certificate request; preview == apply; never touch unmarked proxy hosts; never surface a certificate private key

**Scale/Scope**: one NPM instance, tens of proxy hosts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status |
|---|---|
| I. No real operational data | Pass. Fixtures captured from a local throwaway NPM with `example.test` names; tokens, PEMs and loopback IPs redacted (shape kept). No default URL literal: derived from `proxy: true` or `NPM_API_URL`. |
| II. Code quality | Pass. Remote execution untouched (HTTP client, like Authentik/Cloudflare). NPM responses validated with zod. Shared nginx body renderer lives in one place (`src/lib/proxy/nginx-locations.ts`). Errors name what failed and the env var/NPM action that fixes it. |
| III. Testing | Pass. Driver tests with a fake client; client tests with stubbed fetch over captured, redacted fixtures (R-fixtures rule satisfied). `RealNpmClient` additionally verified manually against the live container (quickstart §4). nginx driver output stays byte-identical (existing tests). |
| IV. UX consistency | Pass. Dry run by default through the existing `sync-proxy`/`syncProxyLive` paths; preview rendered from the same plan apply executes. No new flags. README/docs/CLAUDE.md/CONTRIBUTING (if affected) updated in the same change. Settings page change verified at desktop and ≤640px. |

Post-design re-check: unchanged — all pass. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/014-nginx-proxy-manager-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/driver-and-client.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/ids.ts                      # + 'nginx-proxy-manager'
src/lib/proxy/driver.ts                   # DriverDeps.configPath: string | null
src/lib/proxy/index.ts                    # register driver; driverDeps null path
src/lib/proxy/file-driver.ts              # guard: null configPath is a programming error
src/lib/proxy/nginx-locations.ts          # NEW shared server-body renderer (moved from nginx.ts)
src/lib/proxy/drivers/nginx.ts            # uses nginx-locations.ts; output unchanged
src/lib/proxy/drivers/nginx-proxy-manager.ts  # NEW driver: plan/apply/snapshot, matching, certificates
src/lib/npm-client.ts                     # NEW NpmClient, RealNpmClient, buildNpmClient
src/cli.ts, src/web/server.ts, src/mcp/server.ts   # dotenv data/nginx-proxy-manager.env
web-client/src/lib/settings-display.ts    # hide config path when defaultConfigPath is null
test/fixtures/nginx-proxy-manager/*.json  # captured, redacted (already added)
test/lib/npm-client.test.ts               # NEW
test/lib/proxy/nginx-locations.test.ts    # NEW (or covered via nginx driver tests)
test/lib/proxy/drivers/nginx-proxy-manager.test.ts  # NEW
test/lib/proxy/index.test.ts, test/web-client/*settings*   # updated
docs/reverse-proxy/nginx-proxy-manager.md # NEW; README.md index/docs index, environment-variables.md
CLAUDE.md                                 # driver bullet + env file + assumptions
```

**Structure Decision**: single project; the driver follows the existing
`src/lib/proxy/drivers/` layout and the client follows
`src/lib/cloudflare-client.ts`.

## Phases (for tasks)

1. **Interface groundwork** — id, `configPath: string | null`, driverDeps,
   fileDriver guard, Settings `proxyFieldView`; extract the nginx server body
   renderer with the nginx driver's tests proving byte-identical output.
2. **Client** — `NpmClient` + zod schemas + error mapping + env loading,
   tested over the fixtures.
3. **US1/US2 core** — desired body, ownership, matching, drift, plan
   preview, apply ordering, read-back, conflicts, snapshot.
4. **US3** — forward-auth `advanced_config` via the shared renderer.
5. **US4** — certificate coverage/selection/request.
6. **US5 + docs** — messages, docs pages, CLAUDE.md, live quickstart run,
   Settings page browser check.

## Complexity Tracking

None.
