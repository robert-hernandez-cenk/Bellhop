# MCP server

`buildMcpServer` (`src/mcp/build-server.ts`, issue #16) is the one tool registry, served two ways:

- **stdio** (`src/mcp/server.ts`, `npm run mcp`): runs as the local operator with CLI-level trust, no authentication. It uses its own checkout's `inventoryPath()`/`dataDir()`, so whichever checkout runs it is the one it manages; nothing in this repo says where it should run.
- **Streamable HTTP** at `/mcp` on the web service (#65/#66): authenticated by a bearer (a token from Bellhop's own authorization server, admins only, or the `mcpApiKey` secret), one `McpServer` per MCP session. The host, routes and authorization server live in `src/web/mcp/`; see `src/web/CLAUDE.md` ("MCP over HTTP").

Neither applies permission filtering (so web-UI-only restrictions such as admin-gating of `authMode`/`oidcRedirectUris` edits do not apply here); over HTTP that is why only admins may sign in.

`McpServerOptions.actor` is who the server acts for, recorded as `triggeredByUsername` with `triggeredVia: 'mcp'` on every job it starts: the OS user for stdio (`os.userInfo()`), the signed-in admin's username or `api-key` over HTTP; unset, `'mcp'` (what every MCP job recorded before #65). `McpServerOptions.tracker` lets the HTTP host share one `PromptTracker` across its sessions.

## Tools

- One tool per `MCP_OPERATIONS` entry (every operation except `migrate-nfs-mount`). Each is a dry-run preview unless called with `apply: true`, which enqueues a job and returns its id.
- `edit_guest`.
- Read-only tools: `get_inventory`, `get_guest_status`, `audit_nfs_mounts`, `list_install_apps`, `check_install_app`.
- Job tools: `list_jobs`, `get_job` (offset-paged logs and any pending prompt), `wait_for_job`, `answer_job_prompt`, `dismiss_job_prompt`, `cancel_job`.
- OIDC and VPN gateway tools, below.

## `wait_for_job` and elicitation

`wait_for_job` (`src/mcp/wait-for-job.ts`, issue #58) is the MCP counterpart to the web UI's prompt relay (detection itself is shared; see `src/web/jobs/CLAUDE.md`). It blocks on a job this process owns until it finishes, pauses, or `maxWaitSeconds` (default 300) passes. When the job pauses at `awaiting_input` it asks the human directly through MCP form elicitation (answer / not a real prompt, resume / cancel the job), then keeps waiting in the same call.

- A client that doesn't declare elicitation support, a declined form, an elicitation error, or a dialog left unanswered for 10 minutes all return `prompt_pending`, so the model falls back to `answer_job_prompt` and friends.
- A declined prompt stays handed off (no later `wait_for_job` call re-asks it) until the job pauses on a new one.
- If the human picks "cancel the job" in the dialog, the tracker marks that prompt as cancelling so no concurrent or repeat `wait_for_job` call re-asks it while the cancellation settles. `PromptTracker` (`src/mcp/elicitation.ts`) also keeps concurrent waiters from opening duplicate dialogs.
- `maxWaitSeconds` is not enforced while a dialog is open; the elicitation request's own 10-minute timeout bounds it instead (issue #174). That is longer than the SDK's 60s default, which would drop real dialogs, and well under `JobRunner`'s 15-minute abandon timer, so a client that never shows the dialog (a remote Claude Code session did exactly that) hands the prompt back to the model with time left to ask in chat, instead of silently stalling until the job is cancelled. On timeout the SDK withdraws the dialog, and the prompt stays handed off the same as a decline.
- The dialog's message leads with the prompt text and the answer field's title repeats it, because Claude Code's terminal folds all but the first few message lines.
- Cancelling a `wait_for_job` call never cancels the job.
- Over HTTP every session shares one `PromptTracker` (`McpHttpHost`), so two sessions waiting on the same paused job open one dialog between them.
- `wait_for_job` is owner-only (`requireOwned` in `src/mcp/job-helpers.ts`, its only remaining caller): it blocks on the job's in-memory controller/events, which only the owning process holds. The other job tools can control a job owned by the web service through the cross-process mechanism; see `src/web/jobs/CLAUDE.md` (cross-process job watching and control).

## Shared job database

The stdio server shares `data/jobs.sqlite3` with the web service. `JobRunner` stamps an `owner` on every job (`'web'`, or `'mcp:<pid>'`; HTTP MCP jobs run on the web service's runner, so they are `'web'` and survive the client disconnecting), and orphan cleanup (`JobStore.interruptOrphaned`) touches only the caller's own rows plus rows of MCP processes whose pid is dead, so neither process's startup interrupts the other's in-flight jobs. See `src/web/jobs/CLAUDE.md` (ownership and orphan cleanup).

## `ping()` workaround

`buildMcpServer` sends one throwaway `ping()` in `server.server.oninitialized` to work around a bug in the *client's* `Protocol#_oncancel` (confirmed against @modelcontextprotocol/sdk 1.30.0, 2026-09), which silently drops a cancellation whose request id is 0. It can be removed only once the MCP clients this server is actually used with (Claude Code and others, each bundling their own SDK) ship a fixed `_oncancel`; upgrading this repo's own SDK dependency only fixes the in-repo test client.

## stdout and stdin (stdio only)

stdout is the protocol channel, so `src/mcp/server.ts` redirects `console.log` to stderr at startup. On stdin close the server cancels its jobs and exits; a job still running when the client session ends is therefore interrupted.

## Native OIDC gating tools (issue #1)

- `adopt-oidc-client` is registered like every other `MCP_OPERATIONS` entry (`adopt_oidc_client`, preview/apply, `fleetWide: true`).
- `edit_guest`'s input shape (`EDIT_GUEST_SHAPE`) already covered `authMode`/`oidcRedirectUris`, so no new tool was needed. It also accepts `confirmOidcClientDeletion: true`, required for the same edit the Dashboard's confirmation dialog gates; the tool description tells the model to ask the user first, since this server has no dialog of its own. `authMode`/`oidcRedirectUris` changes need no admin check here, because the server always runs with CLI-level trust.
- `EDIT_GUEST_SHAPE` also has `oidcMobileRedirectUris` (issue #22, same shape and admin-free trust level as `oidcRedirectUris`); `edit_guest` already covers every writable guest field.
- A standalone `get_oidc_client` tool (`src/mcp/build-server.ts`) wraps `runOidcClientInfo` (`commands/networking/oidc-credentials.ts`) and returns an OIDC-gated entry's issuer and client ID only, never the secret, with a `secretAvailableFrom` field pointing at the Dashboard or the `oidc-credentials` CLI command instead.

See `src/commands/networking/CLAUDE.md` (`oidc-credentials`, adoption, and why the secret never reaches MCP).

## VPN gateway runtime tools (issue #7)

Five tools: `get_vpn_gateway_status`, `list_vpn_gateway_servers`, `list_vpn_gateway_cities`, `list_vpn_gateway_groups`, `connect_vpn_gateway`.

- `src/operations/vpn-gateway.ts` is the one implementation behind both these tools and `/api/networking/gateways/*` (`src/web/routes/networking.ts`, a thin adapter that keeps `requireResourceAccess` and maps a `GatewayResult`'s `not-found` to 404 and `upstream` to 502). It is a shared non-`Operation` action, like `runEditGuest`: four of the five are plain reads, and `connect_vpn_gateway` is deliberately immediate rather than preview/apply, matching the Dashboard's Connect button, which has no preview either.
- Each call returns a `GatewayResult`. A tool returns the gateway's own JSON body on success; on failure it throws (surfaced by the SDK as an `isError` result) with the exact message text the web route's error body shows, so a tool failure and a Dashboard failure read identically.
- Timeouts match the web route: 5s for `get_vpn_gateway_status`, 15s for the three list tools, none for `connect_vpn_gateway` (a VPN reconnect can legitimately take a while, and aborting it partway could tear down a switch that was actually succeeding).
