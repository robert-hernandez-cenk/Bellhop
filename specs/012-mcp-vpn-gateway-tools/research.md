# Research: MCP Tools for VPN Gateway Runtime Controls

## R1. Operation vs. plain shared functions

**Decision**: plain exported functions in `src/operations/vpn-gateway.ts`, not entries in `MCP_OPERATIONS`.

**Rationale**: an `Operation` means "preview, then enqueue a background job that applies". Four of these five actions are reads, and connect was decided to act immediately with no job (spec Assumptions). `edit-guest.ts`'s `runEditGuest` already sets the precedent: a shared, non-`Operation` action in `src/operations/`, called by a web route and by a hand-registered MCP tool (`edit_guest`).

**Alternatives considered**: modelling connect as an `Operation` gives a preview and a job. The user rejected that because the preview would only echo its inputs, and the web UI's button has no such step.

## R2. Result shape and failure classification

**Decision**: every action returns
`{ ok: true; body: unknown } | { ok: false; kind: 'not-found' | 'upstream'; error: string; body: unknown }`.

- `not-found`: an unknown gateway, or a gateway with no ip. `body` is `{ error }`, and the web maps it to 404.
- `upstream`: the fetch threw, or the gateway answered non-2xx. The web maps it to 502 with `body` unchanged, which is the gateway's own JSON on a non-2xx and `{ error: "Failed to reach gateway at <ip>:8080 -- <msg>" }` on a network failure. This is exactly today's `proxyToGateway`.
- `error` is the message the MCP tool reports. It is `body.error` when that is a non-empty string, which covers both the reachability message and the agent's own `writeError` JSON. Otherwise it is `VPN gateway <name> returned HTTP <status>`. The fallback only arises for a non-JSON error body, which the web already turns into `{}`.

**Rationale**: it keeps the web response byte-identical (FR-004) and gives MCP the same text the web UI displays (FR-006). The gateway agent (`vpn-gateway-agent/httpapi/httpapi.go`) always reports errors as `{"error": "..."}` via `writeError`: 500 on status/state failures, 502 on provider failures, 404 on "city/server-group selection not supported by this provider" (a PIA gateway's `/cities` and `/groups`), and 400 on a bad connect body.

**Alternatives considered**: throwing typed errors from the shared functions. That forces a try/catch in each route handler, which is the duplication `proxyToGateway` was written to avoid.

## R3. fetch injection

**Decision**: the shared functions take a `fetchImpl: typeof fetch` argument. The web route keeps its existing `fetchImpl = fetch` default parameter. MCP passes `deps.fetchImpl ?? fetch`, the same idiom `list_install_apps` uses.

## R4. Timeouts

**Decision**: the constants `STATUS_TIMEOUT_MS` (5s) and `LIST_TIMEOUT_MS` (15s) move with the code, along with their issue #145 comment. Connect still sends no `signal`.

**Rationale**: FR-007. A connect runs `wg-quick down/up` plus a public-IP lookup on the gateway. Adding a timeout could abort a switch that is working, and it is out of scope.

## R5. Tool naming and inputs

**Decision**: `get_vpn_gateway_status`, `list_vpn_gateway_servers`, `list_vpn_gateway_cities`, `list_vpn_gateway_groups`, `connect_vpn_gateway`. Every tool takes `name` (the gateway guest name). Cities also takes `country` (optional, default `''`). Connect also takes `country`, `city`, and `group` (each optional, default `''`).

**Rationale**: they follow the existing `get_*`/`list_*` read-tool naming (`get_guest_status`, `list_install_apps`). An empty default mirrors the web route's `req.body?.country ?? ''` and `req.query.country` fallback.

## R6. Permissions

**Decision**: the web route keeps `requireResourceAccess` (guest-scoped) in front of every handler. The MCP tools have no filtering, like every other MCP tool (CLI-level trust).
