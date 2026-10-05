# Feature Specification: MCP over HTTPS with sign-in and an API-key fallback

**Feature Branch**: `issue-65-mcp-https-transport`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Issues #65 and #66. The MCP server only speaks stdio, so a client has to launch it as a child process on the machine that holds the checkout; nothing on another machine (a remote Claude Code session, another LAN host) can reach it. Add a network transport, served over HTTPS at `/mcp` on Bellhop's existing web address (for example `https://bellhop.example.com/mcp`). Because a network listener changes the trust model, every request must be authenticated: primarily by the sign-in flow MCP clients already implement (the client opens a browser, the person signs in, the client receives a token), and secondarily by a single API key for clients that cannot open a browser. Every job started through it records who started it and from which front end.

## User Scenarios & Testing *(mandatory)*

The actors are the **operator** (Bellhop's administrator, signed in through Authentik as an admin), **MCP clients** (Claude Code or any other MCP client, possibly on another machine), **headless clients** (scripts or agents that cannot open a browser), and **restricted web users** (people the operator lets into the web UI who are not admins).

### User Story 1 - Connect an MCP client over the network by signing in (Priority: P1)

The operator adds `https://bellhop.example.com/mcp` to their MCP client as a remote server. On first use the client is told that sign-in is required, discovers how to sign in, registers itself, and opens the operator's browser. The operator sees a Bellhop page naming the client and asking whether to allow it to act as them, approves, signs in through Authentik (instantly if already signed in there), and the browser hands control back to the client. From then on every Bellhop tool is available in that client, exactly as over stdio, acting as that operator.

**Why this priority**: this is the feature; remote reachability without an authentication story is not acceptable.

**Independent Test**: point an MCP client at a running web service with web sign-in configured, complete the browser flow as an admin, then call `get_inventory` and a preview tool and confirm they return the same results the stdio server does.

**Acceptance Scenarios**:

1. **Given** no credentials, **When** a client sends any request to `/mcp`, **Then** it receives 401 with a pointer to the sign-in discovery document, before any MCP handling happens.
2. **Given** a client that has discovered sign-in, **When** it registers itself and starts authorization, **Then** the browser shows a Bellhop consent page naming the client and the address it will return to.
3. **Given** the consent page, **When** the person declines, **Then** the client receives an "access denied" result and no token is issued.
4. **Given** the consent page, **When** the person approves and signs in through Authentik as an admin, **Then** the client receives a token and can call every tool.
5. **Given** a signed-in MCP client, **When** its token expires, **Then** it can renew it without the person signing in again, for up to 30 days.
6. **Given** a signed-in MCP client, **When** the person signs out of the web UI in their browser, **Then** the MCP client keeps working (the two sign-ins are independent).

---

### User Story 2 - Only admins, and only while they stay admins (Priority: P1)

MCP tools act with operator-level trust (provisioning, deletes, guest edits) and do not apply the web UI's per-resource permissions. So only members of Bellhop's admin groups may sign in for MCP, and someone who stops being an admin, or is deactivated in Authentik, loses MCP access within minutes.

**Why this priority**: without it, a restricted web user could bypass every permission the operator set, which the project treats as a correctness bug.

**Independent Test**: complete the flow as a non-admin and confirm no token is issued; then, as an admin with a token, remove them from the admin group at the provider and confirm a request after the next identity re-check is refused.

**Acceptance Scenarios**:

1. **Given** a person who is not in an admin group, **When** they complete Authentik sign-in in the MCP flow, **Then** Bellhop shows a page saying MCP access is limited to admins and issues no token.
2. **Given** an MCP token whose person was removed from the admin groups, **When** the identity is next re-checked (at most 5 minutes after the change, on the next request), **Then** requests with that token are refused with 403.
3. **Given** an MCP token whose person was deactivated or whose Authentik grant was revoked, **When** the identity is next re-checked, **Then** the token stops working and the client must sign in again.
4. **Given** an MCP session opened by one person, **When** a request for that session arrives with a different person's token or the API key, **Then** it is refused.

---

### User Story 3 - Headless access with an API key (Priority: P2)

For a client that cannot open a browser, the operator creates an API key on the Settings page (or with `set-config`), copies it into the client's configuration as `Authorization: Bearer <key>`, and the client can call every tool. The key is write-only: Bellhop shows whether one is set, never what it is.

**Why this priority**: it covers automation and clients without browser sign-in, but the sign-in flow is the primary path.

**Independent Test**: generate and save a key on the Settings page, call `/mcp` with it and confirm tools work; call with a wrong key and confirm 401; clear it and confirm the previously working key is refused.

**Acceptance Scenarios**:

1. **Given** the Settings page as an admin, **When** they press Generate, **Then** a strong random key appears in the input for them to copy, and is stored only when they save; the server never sends any key value back.
2. **Given** a stored key, **When** a client presents it, **Then** requests succeed and jobs record the caller as the API key.
3. **Given** a stored key, **When** a client presents a different value, **Then** it receives 401.
4. **Given** the key is cleared, **When** a client presents the old value, **Then** it receives 401.
5. **Given** the CLI, **When** the operator runs `set-config mcpApiKey --stdin --apply` (or the no-echo prompt), **Then** the key is stored; passing it as an argument is refused, as for every secret.
6. **Given** the Settings page, **When** it loads, **Then** it shows only whether a key is set and whether the environment overrides it.

---

### User Story 4 - Know who did what, and from where (Priority: P2)

Every job records the person who started it and the front end it came through: the web UI or MCP. A job started over MCP shows the signed-in person (or the API key), not a generic `mcp`.

**Why this priority**: once MCP is reachable from the network, the job history is the audit trail of who changed what.

**Independent Test**: start one job from the web UI, one over MCP as a signed-in admin, one with the API key, and one from the stdio server; confirm the job list and `get_job`/`list_jobs` show the right person and front end for each.

**Acceptance Scenarios**:

1. **Given** a job started from the web UI, **Then** it records the signed-in user and front end `web`.
2. **Given** a job started over HTTP MCP by a signed-in admin, **Then** it records that admin's username and front end `mcp`.
3. **Given** a job started over HTTP MCP with the API key, **Then** it records the caller as `api-key` and front end `mcp`.
4. **Given** a job started by the stdio MCP server, **Then** it records the operating-system user running it and front end `mcp`.
5. **Given** jobs recorded before this change, **Then** they keep showing their stored username, with no front end.

---

### User Story 5 - Long-running jobs and prompts work for remote clients (Priority: P2)

An admin starts an `install-app` over HTTP MCP, waits on it, answers an installer prompt in the dialog their client shows, and disconnects; the job keeps running and appears in the web UI's job list like any other.

**Why this priority**: elicitation and job waiting are how MCP clients drive the interactive tools today; they must work per remote session.

**Independent Test**: from two concurrent MCP sessions, start a job that pauses on a prompt and call `wait_for_job` from both; confirm only one dialog is shown, the answer resumes the job, and closing both sessions leaves the job running.

**Acceptance Scenarios**:

1. **Given** a job started over HTTP MCP, **When** it pauses on a prompt and the session supports form dialogs, **Then** `wait_for_job` asks that session's person directly, as over stdio.
2. **Given** two sessions waiting on the same paused job, **Then** only one dialog is open at a time.
3. **Given** a job started over HTTP MCP, **When** the client disconnects, **Then** the job continues and can be watched or controlled from the web UI or another session.
4. **Given** an MCP session idle for 30 minutes, **Then** the server forgets it; the client re-initializes on its next request.

---

### Edge Cases

- Neither web sign-in nor an API key is configured: `/mcp` refuses every request with an error naming both ways to enable it (configure web sign-in, or set `mcpApiKey`), and the sign-in discovery documents are not served. The web UI itself still starts and works.
- Web sign-in is configured but its redirect address is plain `http://` on loopback (development): sign-in works on loopback only, as for the web UI.
- A client registers with a return address Bellhop has not seen before: allowed (that is how MCP clients register), but the consent page always shows that address so the person can spot an unexpected one.
- A client presents a token that expired, was revoked, or was never issued: 401, and the client starts sign-in again.
- An authorization code is presented twice, after 10 minutes, by a different client, or with a wrong verifier: refused, no token issued.
- A refresh token is used twice: the second use is refused (refresh tokens rotate).
- The API key is set by environment variable: it wins over the stored value, and the Settings page says so and refuses to edit it, as for every env-pinned secret.
- A key with whitespace or under 32 characters: rejected by validation (a pasted newline would otherwise fail later as an opaque 401; a short key is too guessable for a network listener).
- The web service restarts: issued tokens and registered clients survive; in-memory MCP sessions do not (clients re-initialize transparently).
- Authentik is unreachable during a re-check: the request is served with the last-known identity and retried later, as for web sessions.

## Requirements *(mandatory)*

### Functional Requirements

**Transport**

- **FR-001**: The web service MUST serve the MCP protocol over Streamable HTTP at the path `/mcp` on its existing address, alongside the web UI, with the same tools, inputs, outputs and previews as the stdio server.
- **FR-002**: The stdio server (`npm run mcp`) MUST keep working unchanged and MUST NOT require any credential.
- **FR-003**: Each MCP session MUST have its own protocol state (including form dialogs and the cancellation workaround), MUST be bound to the identity that initialized it, and MUST refuse requests carrying a different identity.
- **FR-004**: All HTTP MCP sessions MUST share the web service's job runner: their jobs are owned by the web service, survive a client disconnecting, and are visible and controllable from the web UI.
- **FR-005**: At most one prompt dialog per paused job MUST be open across all sessions at a time.
- **FR-006**: An MCP session idle for 30 minutes MUST be discarded.

**Authentication**

- **FR-007**: Every request to `/mcp` MUST carry `Authorization: Bearer <credential>`; a missing, unknown, expired or revoked credential MUST be answered 401, with a pointer to the protected-resource discovery document, before any MCP handling. A browser session cookie MUST NOT authenticate `/mcp`.
- **FR-008**: Bellhop MUST act as the authorization server for `/mcp`, publishing the standard discovery documents and supporting client self-registration, authorization code with PKCE, token refresh, and token revocation, as MCP clients expect.
- **FR-009**: The authorization step MUST show a Bellhop consent page naming the registering client and its return address, and MUST issue nothing unless the person approves.
- **FR-010**: After approval, the person MUST sign in through Bellhop's existing Authentik web-login client. This sign-in MUST be independent of any browser web-UI session: signing out of the web UI does not end MCP access, and vice versa.
- **FR-011**: Only a person who is an admin (Bellhop's admin predicate) at sign-in MAY receive a token; anyone else MUST be shown a page explaining MCP access is limited to admins.
- **FR-012**: An MCP identity MUST be re-checked against Authentik on the same schedule and with the same outcomes as web sessions (at most every 5 minutes; refused ends access; unreachable keeps the last-known identity). A request whose re-checked identity is no longer an admin MUST be refused with 403.
- **FR-013**: Access tokens MUST expire after 1 hour; refresh tokens MUST rotate on use and expire 30 days after sign-in. Authorization codes MUST be single-use and expire after 10 minutes.
- **FR-014**: Access tokens, refresh tokens, authorization codes and consent ids MUST be stored only as hashes and MUST survive a service restart, as MUST client registrations. (A registered client's own secret is kept as registered, because the client-authentication check compares it directly; it grants nothing without a refresh token.)
- **FR-015**: Bellhop's public address for discovery MUST come from the configured web-login redirect address; no new address setting is introduced.

**API key**

- **FR-016**: A new secret setting `mcpApiKey` (environment override `MCP_API_KEY`) MUST be accepted as a bearer credential on `/mcp`, compared in constant time, identifying the caller as `api-key`.
- **FR-017**: `mcpApiKey` MUST follow the existing secret-settings rules: write-only on the Settings page (set, replace, clear; shows only whether it is set and whether the environment pins it), settable from the CLI only through stdin or the no-echo prompt, never in an API response, log, job record or MCP response.
- **FR-018**: The Settings page MUST offer a Generate action that creates a random key of at least 32 bytes in the browser and places it in the input; the key is stored only when the admin saves.
- **FR-019**: A stored or environment key MUST be validated: no whitespace, at least 32 characters.

**Fail closed**

- **FR-020**: When neither web sign-in nor an API key is configured, `/mcp` MUST refuse every request with an error naming how to enable it; the rest of the web service MUST be unaffected.

**Attribution**

- **FR-021**: Every job started from a front end MUST record it (`web` or `mcp`) alongside the existing username; the scheduler's own daily run keeps the username `scheduler` and records no front end. Jobs over HTTP MCP record the signed-in person's username or `api-key`; jobs from the stdio server record the operating-system user.
- **FR-022**: The web UI's job list and detail, and the MCP `list_jobs`/`get_job` tools, MUST show the front end next to the username. Jobs recorded before this change show no front end.

**Documentation**

- **FR-023**: The user docs MUST describe connecting a remote MCP client (sign-in and API key), the admin-only rule, and the proxy route requirement; `src/mcp/CLAUDE.md` and `src/web/CLAUDE.md` MUST describe the new transport, authorization server, and attribution.

### Key Entities

- **MCP client registration**: a client that registered itself: generated id, display name, allowed return addresses, registration time.
- **MCP grant**: one person's approval for one client: the client, the person's re-checkable identity (independent of browser sessions), the current refresh token's hash, creation and expiry.
- **Authorization code**: short-lived, single-use, tied to a grant, the client, the return address and the PKCE challenge.
- **Access token**: short-lived bearer credential tied to a grant.
- **MCP session**: in-memory protocol state for one connected client, bound to the identity that opened it, discarded after 30 minutes idle.
- **API key**: the single `mcpApiKey` secret.
- **Job attribution**: existing username plus the new front end (`web` | `mcp`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can connect a new remote MCP client and run their first tool in under 2 minutes, with no shell access to the Bellhop host.
- **SC-002**: 100% of requests to `/mcp` without a valid credential are refused before any tool runs.
- **SC-003**: A non-admin cannot obtain MCP access through any path; an admin demoted at the provider loses access within 5 minutes of their next request.
- **SC-004**: Every job started after this change shows who started it and from which front end.
- **SC-005**: The stdio server behaves identically for existing local clients (no new prompt, flag or credential).
- **SC-006**: No secret value (API key, token, client secret, code) appears in any API response, log line, job record or MCP response, except the one-time token responses of the sign-in flow to the client that requested them.

## Assumptions

- The web service is reached through the operator's reverse proxy over HTTPS on Bellhop's own subdomain, whose route is not forward-auth gated (true since #69), so `/mcp` and the discovery paths pass through unchanged.
- Web sign-in (#69) is the identity source; MCP sign-in requires it to be configured. Without it, only the API key works.
- One Bellhop service process (an existing single-operator assumption): MCP sessions and the prompt-dialog de-duplication are in-process.
- Usernames (not display names) are recorded, as for web jobs today.
- API-key callers are trusted like the operator; one shared key is enough (several named keys are out of scope).

## Out of Scope

- Per-resource permission filtering for MCP tools (non-admins are refused instead).
- Recording CLI actions.
- Bellhop-managed web login derived from its own guest, and moving the custom OIDC settings to their own tab (#85).
- A separate MCP HTTPS process or its own TLS certificate settings.
- Multiple or named API keys.
