# Contract: MCP over HTTP and its authorization server

Examples use `https://bellhop.example.com` (the origin of `webUiOidcRedirectUri`).

## `POST|GET|DELETE /mcp` — Streamable HTTP

Order of checks, each before any MCP handling:

1. Neither usable sign-in (configured, with an https:// or localhost/127.0.0.1 redirect URI) nor a valid `mcpApiKey` → `503 {"error":"MCP over HTTP is not enabled: configure web sign-in with an https:// redirect URI (bellhop configure-web-login <entry> --apply) or set an API key (Settings > MCP, or bellhop set-config mcpApiKey --stdin --apply)"}`. An invalid `MCP_API_KEY` counts as no key (a warning names the variable) and never blocks sign-in tokens.
2. Missing/unknown/expired/revoked bearer → `401`, `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="https://bellhop.example.com/.well-known/oauth-protected-resource/mcp"` (the `resource_metadata` parameter only when sign-in is configured). Cookies are ignored.
3. Signed-in identity no longer an admin → `403` (`insufficient_scope`).
4. `Mcp-Session-Id` present but unknown, or opened by a different principal → `404` (what makes a client re-initialize; after re-authorization the same person holds a new grant).
5. No session id and the body is an `initialize` request → new session; otherwise without a session id → `400`.

Then the SDK transport handles the request. Tool set, inputs and outputs are identical to stdio.

## Discovery (only when sign-in is configured)

- `GET /.well-known/oauth-protected-resource/mcp` → `{ "resource": "https://bellhop.example.com/mcp", "authorization_servers": ["https://bellhop.example.com/"], "resource_name": "Bellhop" }`
- `GET /.well-known/oauth-authorization-server` → SDK metadata: `authorization_endpoint` `/authorize`, `token_endpoint` `/token`, `registration_endpoint` `/register`, `revocation_endpoint` `/revoke`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`.

When sign-in is not configured these paths, `/authorize`, `/token`, `/register` and `/revoke` are not served (fall through to the normal app).

## `POST /register`

RFC 7591 via the SDK. Response includes `client_id` (and `client_secret` for a confidential client).

## `GET|POST /authorize`

SDK-validated (`client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`). Responds `200` HTML consent page:

- "Allow **<client_name or client_id>** to use Bellhop as you?", "It will return to **<redirect origin>**."
- Form `POST /auth/mcp/consent` with hidden `pending=<id>` and buttons `decision=approve|deny`.
- Sets cookie `bellhop_mcp_<id-prefix>` = `<id>` (path `/auth`, HttpOnly, SameSite=Lax, Secure — like the login cookies, which browsers also accept on localhost — 10 min).

## `POST /auth/mcp/consent`

- Pending missing/expired/cookie mismatch → `400` page "This authorization request has expired or was already used. Start again from your MCP client."
- `deny` → `302` to `redirect_uri?error=access_denied&state=…`.
- `approve` → restarts the pending request's 10 minutes and starts the Authentik sign-in exactly like `/auth/login` (login attempt cookie, `302` to the provider), the attempt carrying the pending id. If the sign-in cannot start (web login unconfigured, provider unreachable) → `302` to `redirect_uri?error=temporarily_unavailable&error_description=…&state=…`.

## `GET /auth/callback` (extended)

For an attempt with a pending MCP authorization, after the provider sign-in succeeds:

- Not an admin → `403` page "MCP access is limited to Bellhop admins (members of <adminGroup> or <builtinAdminGroup>)." No code; the dedicated session is deleted. Client receives nothing (the browser stays on Bellhop).
- Admin → dedicated session created (no cookie set, existing browser cookie untouched); `302` to `redirect_uri?code=<code>&state=<state>`.

A failed MCP sign-in (provider error → `access_denied`, anything else → `server_error`) → `302` to `redirect_uri?error=…&error_description=…&state=…`, never the web-login failure page. A callback with no matching attempt still gets the web page (no client is known).

## `POST /token`

- `grant_type=authorization_code`: SDK verifies PKCE against the stored challenge; Bellhop verifies the code is unused, unexpired, for this client and redirect URI. → `{ access_token, token_type: "bearer", expires_in: 3600, refresh_token }`.
- `grant_type=refresh_token`: refresh must match a live grant of this client; rotates. Reused or unknown → `400 invalid_grant`.

## `POST /revoke`

Refresh token → grant and its access tokens deleted; access token → that token deleted; unknown → `200` (RFC 7009).

## Settings API

`GET /api/settings` → `secrets.mcpApiKey: { set: boolean, source: 'environment'|'settings'|'none' }`. `PATCH /api/settings { "mcpApiKey": "<value>" | null }` follows the existing secret rules (validation message never echoes the value; env-pinned refused).

## Job fields

`GET /api/jobs`, `GET /api/jobs/:id`, MCP `list_jobs`/`get_job`: add `triggeredVia: "web" | "mcp" | null`.
