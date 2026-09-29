# Implementation Plan: MCP Tools for VPN Gateway Runtime Controls

**Branch**: `issue-7-mcp-vpn-gateway-tools` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/012-mcp-vpn-gateway-tools/spec.md`

## Summary

Move the VPN gateway lookup and gateway-API call out of `src/web/routes/networking.ts` into a shared module, `src/operations/vpn-gateway.ts`. It exports one function per gateway action, and each returns a small result type that is either the gateway's body on success or a classified failure. The web route becomes a thin adapter that maps each failure kind to the status code it uses today (404 or 502). The MCP server registers five tools that call the same functions and turn a failure into an `isError` result carrying the same message. Connect acts immediately, the same as the Dashboard's Connect button.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22+, run with `tsx`

**Primary Dependencies**: Express 5 (web route), `@modelcontextprotocol/sdk` (MCP tools), `zod` (tool input schemas)

**Storage**: N/A. Reads the inventory already loaded in memory (the gateway guest's `ip` and `vpnGateway`).

**Testing**: `node --test` with `supertest` for the route; the existing MCP harness (`test/support/mcp-harness.ts`) with an injected `fetchImpl` for the tools; direct unit tests for the shared module.

**Target Platform**: The Windows service host (web) and a local stdio MCP process

**Project Type**: CLI + web service + MCP server sharing `src/operations/`

**Performance Goals**: Unchanged. The existing timeouts are kept: 5s for status, 15s for the lists, none for connect.

**Constraints**: The web route's observable behavior must not change (FR-004, SC-003).

**Scale/Scope**: One new module, one route rewrite, five tool registrations, and docs.

## Constitution Check

| Principle | Check | Status |
| --- | --- | --- |
| I. No real data | Tests use RFC 5737 addresses (`192.0.2.x`) and example gateway names. | Pass |
| II. Shared logic in one place | Gateway lookup and calls live only in `src/operations/vpn-gateway.ts`. Both front ends call them. | Pass |
| II. Validate inputs crossing the boundary | MCP tool inputs are validated with zod shapes. The gateway body is passed through untouched, as the web route already does. It is our own agent's API, rendered by the client and never interpreted server-side. | Pass |
| III. Tests with the change | New unit and MCP tests. The existing route tests stay as the parity check. | Pass |
| III. Captured fixtures for third-party APIs | The gateway agent is first-party (`vpn-gateway-agent/` in this repo). Fixture bodies follow its `statusResponse`/`writeError` structs rather than being invented. | Pass |
| IV. Dry run by default for infra/inventory changes | Connect changes neither infrastructure nor inventory. It is a runtime control, and the web UI's Connect button is immediate too. The user chose immediate during design (spec Assumptions). | Pass (justified) |
| IV. Same behavior across front ends, one implementation | Both front ends call one function per action. The action is not modelled as an `Operation` because `Operation` means preview + job apply, and these are synchronous reads plus one immediate call. See research R1. | Pass |
| IV. README/CLAUDE.md updated | MCP tool list in README, and the MCP server bullet in CLAUDE.md. | Planned |

## Project Structure

### Documentation (this feature)

```text
specs/012-mcp-vpn-gateway-tools/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── mcp-tools.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── operations/
│   └── vpn-gateway.ts          # NEW: resolveGateway, callGateway, 5 action functions, GatewayResult
├── web/routes/
│   └── networking.ts           # thin adapter: permission check + result -> HTTP status
└── mcp/
    └── build-server.ts         # registers the 5 gateway tools

test/
├── operations/
│   └── vpn-gateway.test.ts     # NEW: unit tests for the shared module
├── web/routes/
│   └── networking.test.ts      # unchanged expectations (parity)
└── mcp/
    └── build-server.test.ts    # new tool tests via the MCP harness
```

**Structure Decision**: follow the existing single-project layout. Shared front-end logic goes in `src/operations/` (constitution II), next to `edit-guest.ts`, which is the precedent for a non-`Operation` shared action (`runEditGuest`) used by both a web route and an MCP tool.

## Complexity Tracking

No violations.
