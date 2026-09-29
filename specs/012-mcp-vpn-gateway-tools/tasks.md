---

description: "Task list for MCP tools for VPN gateway runtime controls"
---

# Tasks: MCP Tools for VPN Gateway Runtime Controls

**Input**: Design documents from `specs/012-mcp-vpn-gateway-tools/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md, quickstart.md

**Tests**: Required. Constitution III says every behavior change ships with tests, and TDD applies: write each test first and watch it fail.

**Conventions**: tests use RFC 5737 addresses (`192.0.2.x`) and example gateway names such as `nordvpn-example-gw-lxc` and `pia-example-gw-lxc` (constitution I). Fake gateway bodies follow the agent's own structs in `vpn-gateway-agent/httpapi/httpapi.go` (`statusResponse`, and `writeError`'s `{"error": "..."}`). Leave `test/web/routes/networking.test.ts`'s existing expectations untouched; it is the parity check (SC-003).

## Phase 1: Setup

None. No new dependencies or configuration.

## Phase 2: Foundational (shared module + web adapter)

**Purpose**: one implementation both front ends call (FR-003). Every user story depends on this phase.

- [x] T001 Create `test/operations/vpn-gateway.test.ts` (node:test, `node:assert/strict`) against a stub `fetchImpl` that records `(url, init)`. Cover:
  - `gatewayStatus(inventory, name, fetchImpl)` for a guest without `vpnGateway` returns `{ ok: false, kind: 'not-found', error: 'Unknown VPN gateway: <name>', body: { error: same } }` and never calls fetch. Same for an unknown name.
  - A gateway guest with no `ip` returns `kind: 'not-found'`, `error: 'VPN gateway <name> has no ip in inventory'`, and no fetch.
  - Success: fetch URL `http://192.0.2.15:8080/status`, `init.signal` is an `AbortSignal`, result `{ ok: true, body }` with body unchanged.
  - fetch throws `new Error('connect ECONNREFUSED')`: `kind: 'upstream'`, `body: { error: 'Failed to reach gateway at 192.0.2.15:8080 -- connect ECONNREFUSED' }`, `error` equal to that same string.
  - Gateway answers 502 with `{ error: 'provider down' }`: `kind: 'upstream'`, body unchanged, `error: 'provider down'`.
  - Gateway answers 500 with a body whose `.json()` rejects: body `{}`, `error: 'VPN gateway <name> returned HTTP 500'`.
  - `gatewayServers` calls `/servers`, and `gatewayGroups` calls `/groups`, each with a signal.
  - `gatewayCities(inv, name, 'Bosnia & Herzegovina', f)` calls `/cities?country=Bosnia%20%26%20Herzegovina`, and `gatewayCities(inv, name, '', f)` calls `/cities?country=`.
  - `connectGateway(inv, name, { country: 'Germany' }, f)` sends `POST /connect` with header `Content-Type: application/json`, body JSON `{ country: 'Germany', city: '', group: '' }`, and **no** `signal`.
- [x] T002 Create `src/operations/vpn-gateway.ts` to make T001 pass. Move out of `src/web/routes/networking.ts`: `resolveGateway`, `proxyToGateway` (renamed `callGateway`), `STATUS_TIMEOUT_MS = 5_000`, `LIST_TIMEOUT_MS = 15_000`, and their comments (including the issue #145 timeout rationale). Export:
  - `type GatewayResult = { ok: true; body: unknown } | { ok: false; kind: 'not-found' | 'upstream'; error: string; body: unknown }`
  - `gatewayStatus(inventory, name, fetchImpl)`, `gatewayServers(...)`, `gatewayCities(inventory, name, country, fetchImpl)`, `gatewayGroups(...)`, `connectGateway(inventory, name, selection: { country?: string; city?: string; group?: string }, fetchImpl)`
  - Upstream `error` is `body.error` when it is a non-empty string, else `VPN gateway <name> returned HTTP <status>` (research R2). Connect has no timeout (R4); keep a comment saying so and why.
- [x] T003 Rewrite `src/web/routes/networking.ts` as a thin adapter. Keep `requireGatewayAccess` on every route. Each handler calls the matching shared function (cities passes `typeof req.query.country === 'string' ? req.query.country : ''`; connect passes `{ country: req.body?.country, city: req.body?.city, group: req.body?.group }`) and responds with `ok ? 200 : kind === 'not-found' ? 404 : 502` and `result.body`. Keep the `networkingRoutes(inventory, inventoryPath, fetchImpl = fetch)` signature. Run `test/web/routes/networking.test.ts` unchanged; it must pass.

**Checkpoint**: typecheck plus the operations and route tests pass. The web behavior is unchanged.

## Phase 3: User Story 1 - Check a VPN gateway from an MCP client (P1) 🎯 MVP

**Goal**: `get_vpn_gateway_status` returns what the web status endpoint returns.

**Independent Test**: harness call against a fake gateway; the result equals the web body.

- [x] T004 [US1] In `test/mcp/build-server.test.ts`, add tests using `setupMcp({ inventory, fetchImpl })` with an inventory holding a NordVPN gateway guest (ip `192.0.2.15`), a guest without `vpnGateway`, and a gateway with no ip:
  - `get_vpn_gateway_status` is in `listTools()`.
  - A success returns JSON text equal to the fake status body.
  - The unknown, no-ip, and unreachable cases each return `isError: true` with exactly the web route's message text.
  - Parity: for the same fake fetch, the tool's parsed result deep-equals `(await gatewayStatus(...)).body` from the shared module.
  - The tool reloads inventory: save an inventory changing the gateway ip to `192.0.2.16` after setup, and assert the next call hits `.16`.
- [x] T005 [US1] In `src/mcp/build-server.ts`, add a local helper `gatewayResult(r: GatewayResult)` that returns `json(r.body)` on success and throws `new Error(r.error)` otherwise (the SDK turns a throw into `isError`, as the file's header comment says). Register `get_vpn_gateway_status` with input `{ name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)') }`. It calls `refresh()` then `gatewayStatus(deps.inventory, args.name, deps.fetchImpl ?? fetch)`. Description: live gateway status (connected, requested/resolved country and city, group, public IP, server, last health check), the same as the Dashboard gateway card.

**Checkpoint**: US1 tests pass.

## Phase 4: User Story 2 - Browse where a gateway can connect (P2)

**Goal**: the three list tools.

**Independent Test**: each tool returns the fake gateway's list, and cities forwards the country.

- [x] T006 [US2] In `test/mcp/build-server.test.ts`, add tests: `list_vpn_gateway_servers` returns the fake `/servers` array; `list_vpn_gateway_cities` with `{ name, country: 'Germany' }` hits `/cities?country=Germany` and returns the array, and without `country` hits `/cities?country=`; `list_vpn_gateway_groups` returns the fake `/groups` array; a PIA gateway answering 404 `{ error: 'server-group selection not supported by this provider' }` gives `isError` with that text.
- [x] T007 [US2] In `src/mcp/build-server.ts`, register `list_vpn_gateway_servers` (`{ name }`), `list_vpn_gateway_cities` (`{ name, country: z.string().default('').describe(...) }`), and `list_vpn_gateway_groups` (`{ name }`), each through `refresh()` plus the shared function plus `gatewayResult`. Descriptions say what each lists. Groups notes it is NordVPN-only (PIA reports not supported), and cities notes the country names come from `list_vpn_gateway_servers`.

**Checkpoint**: US2 tests pass.

## Phase 5: User Story 3 - Switch a gateway's VPN server (P3)

**Goal**: `connect_vpn_gateway` acts immediately.

**Independent Test**: the fake gateway receives exactly `{country, city, group}`, and its response is returned.

- [x] T008 [US3] In `test/mcp/build-server.test.ts`, add tests: `connect_vpn_gateway` with `{ name, country: 'Germany', city: 'Berlin', group: 'P2P' }` sends POST `/connect` with that JSON and returns the fake connect body; with only `country` it sends empty `city`/`group`; no job is created (`jobStore.list()` is empty after the call); a 502 `{ error: 'no servers matched' }` gives `isError` with that text.
- [x] T009 [US3] In `src/mcp/build-server.ts`, register `connect_vpn_gateway` with `{ name, country, city, group }` (the last three `z.string().default('')`). It calls `connectGateway` through `refresh()` plus `gatewayResult`. Per FR-010, the description says it switches the gateway's VPN server immediately (no dry run, no job), briefly interrupts traffic for every guest routed through that gateway, returns the new status, and that valid values come from the list tools.

**Checkpoint**: all stories pass.

## Phase 6: Polish & Cross-Cutting

- [ ] T010 [P] `README.md`: add the five tools to the MCP server's tool list, noting that connect acts immediately.
- [ ] T011 [P] `CLAUDE.md`: in the "MCP server" bullet, add the five gateway tools and name `src/operations/vpn-gateway.ts` as the shared implementation behind both `/api/networking/gateways/*` and the MCP tools. Note that it is a non-`Operation` shared action like `runEditGuest`, and that connect is immediate by design. Check `CONTRIBUTING.md` and update it only if it restates the MCP tool list.
- [ ] T012 Run `npm run typecheck`, `npm test`, and `npm run web:build`, and paste the results. Then run quickstart.md's manual read-only steps against a real gateway if one is reachable. Record anything unverified for the PR.

## Dependencies & Execution Order

- Phase 2 (T001 → T002 → T003) blocks everything.
- US1 (T004 → T005) comes first because it adds the `gatewayResult` helper that US2 and US3 reuse.
- US2 (T006 → T007) and US3 (T008 → T009) both edit `build-server.ts` and its test file, so they run in sequence after US1.
- T010 and T011 are independent of each other; T012 comes last.

## Parallel Opportunities

- T010 and T011 (different files).
- Everything else touches `build-server.ts` or its test, or depends on T002, so it runs in sequence.

## Implementation Strategy

MVP is Phase 2 plus US1: the shared module, the unchanged web behavior, and the status tool. US2 and US3 each add their tools on top. Commit per phase or story: `Share VPN gateway calls between web and MCP (#7)`, then `(#7, US1)`, `(#7, US2)`, and `(#7, US3)`, each with its `tasks.md` checkbox updates.
