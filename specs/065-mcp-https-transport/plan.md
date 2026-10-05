# Implementation Plan: MCP over HTTPS with sign-in and an API-key fallback

**Branch**: `issue-65-mcp-https-transport` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/065-mcp-https-transport/spec.md` (issues #65, #66)

## Summary

Serve the MCP server over Streamable HTTP at `/mcp` on the existing web service, behind the reverse proxy's HTTPS. Bellhop becomes an OAuth authorization server for it using the MCP SDK's `mcpAuthRouter`: a client registers itself, the person approves a Bellhop consent page, signs in through Bellhop's existing Authentik web-login client (a fresh, cookie-less session re-checked every 5 minutes), and only admins get tokens. A write-only `mcpApiKey` secret is the headless fallback. Each MCP session gets its own `McpServer` bound to its principal, sharing the web service's `JobRunner` and one `PromptTracker`. Jobs gain `triggered_via` (`web`/`mcp`) and MCP jobs record the real person. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js ≥ 24, ESM via `tsx`

**Primary Dependencies**: Express 5, `@modelcontextprotocol/sdk` 1.30 (`StreamableHTTPServerTransport`, `mcpAuthRouter`, `requireBearerAuth`; client `StreamableHTTPClientTransport` in tests), `better-sqlite3`, `zod`. No new packages.

**Storage**: `data/sessions.sqlite3` gains `mcp_clients`, `mcp_pending`, `mcp_codes`, `mcp_grants`, `mcp_access_tokens` and `login_attempts.mcp_pending_hash`; `data/jobs.sqlite3` gains `jobs.triggered_via`; `secret_settings` gains `mcpApiKey`. See [data-model.md](data-model.md).

**Testing**: `node --test`; real `buildApp` on `127.0.0.1:0`, `FakeWebLoginClient`, injected clocks, SDK client transport; React helpers with plain `node --test`

**Target Platform**: the Bellhop web service behind the operator's reverse proxy; MCP clients anywhere that can reach it

**Project Type**: web service + React client + CLI + MCP server

**Performance Goals**: one SQLite lookup per `/mcp` request plus the existing ≤ 1 provider re-check per identity per 5 minutes

**Constraints**: no token/key/code in any log, error, job record or MCP response (beyond the token endpoint's own response); stdio unchanged; deterministic tests

**Scale/Scope**: a handful of admins, one service instance

## Constitution Check

| Principle | Status |
|---|---|
| I. No real operational data | Pass. All examples use `bellhop.example.com`, `example-token`; no captured third-party fixture is needed (the OAuth server is Bellhop's own; the Authentik side reuses #69's fake client and captured discovery). |
| II. Code quality | Pass. One provider (`src/web/mcp/oauth-provider.ts`), one store (`McpAuthStore`), one host (`McpHttpHost`); `buildMcpServer` stays the only tool registry for both transports. Request bodies are validated by the SDK's zod schemas; the consent form by zod. Errors name the fix. Web/MCP authorization treated as a correctness requirement (admin check at sign-in and per request). |
| III. Testing | Pass. Every requirement has a test; clocks injected for expiry; the real end-to-end client path (Claude Code through the proxy) is verified manually and recorded in the PR. |
| IV. UX consistency | Pass. No new infrastructure-mutating command (the transport reuses existing operations with their dry-run/apply). Secret masked and write-only in every front end; Settings change verified at desktop and ≤640px. `docs/mcp-server.md`, `docs/configuration.md`, `docs/environment-variables.md`, `src/mcp/CLAUDE.md`, `src/web/CLAUDE.md`, `src/lib/CLAUDE.md`, `web-client/CLAUDE.md` updated in the same change. |

Post-design re-check: unchanged, no violations.

## Project Structure

### Documentation (this feature)

```text
specs/065-mcp-https-transport/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-mcp.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code

```text
src/lib/settings-defs.ts            # mcpApiKey secret, 'mcp' group
src/mcp/build-server.ts             # options: actor, tracker; triggeredVia
src/mcp/server.ts                   # stdio actor = OS user
src/mcp/job-helpers.ts              # summarizeJob.triggeredVia
src/web/login/session-store.ts      # hash-keyed lookups; login_attempts.mcp_pending_hash
src/web/login/sessions.ts           # resolveHash / createForMcp
src/web/mcp/auth-store.ts           # McpAuthStore (clients, pending, codes, grants, access tokens)
src/web/mcp/oauth-provider.ts       # OAuthServerProvider + clients store + verifyAccessToken (key + grants)
src/web/mcp/consent.ts              # consent page render + POST /auth/mcp/consent handler
src/web/mcp/http-host.ts            # McpHttpHost: sessions, principal binding, idle sweep
src/web/mcp/routes.ts               # mcpRoutes(): fail-closed guard, lazy auth router, bearer, /mcp
src/web/routes/auth.ts              # callback branch for MCP attempts; mount consent
src/web/app.ts                      # mount mcpRoutes before requireAuth
src/web/server.ts                   # pass mcp deps (base server deps)
src/web/impersonation.ts            # resolveTriggeredBy adds triggeredVia: 'web'
src/web/jobs/job-store.ts, job-runner.ts  # triggered_via
src/commands/maintenance/backfill-guest-creators.ts  # skip triggeredVia mcp
web-client/src/lib/settings-display.ts, pages/SettingsPage.tsx  # MCP tab, Generate
web-client/src/pages/JobHistory.tsx, api/types.ts, job detail  # front end label
test/web/mcp/*.test.ts, test/mcp/*.test.ts, test/web/login/*.test.ts
docs/mcp-server.md, docs/configuration.md, docs/environment-variables.md
```

**Structure Decision**: the HTTP host and authorization server live under `src/web/mcp/` because they are part of the web service's request pipeline and depend on its session service; `src/mcp/` keeps the transport-independent tool registry.

## Implementation phases

1. **Foundation**: `mcpApiKey` setting; `triggered_via` column + `resolveTriggeredBy` + `buildMcpServer` actor/tracker options + stdio OS user + job displays + backfill rule (US4).
2. **HTTP transport with API key** (US3 + core of US1/US5): `McpHttpHost`, `mcpRoutes` with fail-closed guard and key-only bearer verifier; mount in `buildApp`; Settings MCP tab with Generate.
3. **Authorization server** (US1/US2): hash-keyed session lookups, `McpAuthStore`, provider, consent route, callback branch, lazy `mcpAuthRouter`, admin checks.
4. **Docs and verification**.

## Complexity Tracking

None.
