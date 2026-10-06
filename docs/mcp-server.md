# MCP server

Bellhop's operations are available as tools to an AI assistant through
[MCP](https://modelcontextprotocol.io), two ways: `npm run mcp` starts a
stdio server for an assistant on the same machine, and the web service
serves the same tools over HTTPS at `/mcp` for one anywhere else (see
[Remote access over HTTPS](#remote-access-over-https)).
Every operation tool previews by default and only executes with
`apply: true`; applied work runs as a job you can follow with `wait_for_job`
(or `get_job`). If an installer stops to ask a question, `wait_for_job`
shows it to you as a form when your MCP client supports elicitation. If
your client can't show the form, or you leave it unanswered for 10 minutes,
the assistant sees the question and can answer it with
`answer_job_prompt`.
The stdio server manages the inventory and `data/` directory of the
checkout it runs from.

Five tools cover VPN gateway runtime control, mirroring the Dashboard's
gateway card: `get_vpn_gateway_status`, `list_vpn_gateway_servers`,
`list_vpn_gateway_cities`, `list_vpn_gateway_groups`, and
`connect_vpn_gateway`. Unlike every other tool here, `connect_vpn_gateway`
acts immediately — no `apply: true`, no preview, no job — the same as the
Dashboard's own Connect button, since switching a gateway's VPN server is
the entire action rather than something to preview first.

A job the MCP server starts isn't siloed to it: it shows up live in the web
UI's Job History with the same streaming output, and Stop/answer controls
work from there just as they would for a job started in the web UI. The
same goes in reverse — the MCP control tools can stop or answer a job that
was started from the web UI.

Register it with Claude Code from the checkout you want it to manage:

```bash
claude mcp add bellhop -- npm run --silent mcp
```

On Windows, wrap it in `cmd /c`:

```bash
claude mcp add bellhop -- cmd /c npm run --silent mcp
```

Run that from PowerShell or cmd. From Git Bash, MSYS path conversion
rewrites `/c` into `C:/` before `claude` sees it, and the saved server fails
to start. Disable the conversion for that one command:

```bash
MSYS_NO_PATHCONV=1 claude mcp add bellhop -- cmd /c npm run --silent mcp
```

`--silent` matters: without it npm prints a banner to stdout, which corrupts
the MCP protocol stream.

Run the registration from inside the checkout. These commands use Claude
Code's default local scope, which only applies in the directory you ran
them from, and `npm run` finds the checkout from the working directory. For
a user or project scope, where Claude Code may start the server from
somewhere else, point npm at the checkout explicitly:

```bash
claude mcp add --scope user bellhop -- npm --prefix /path/to/bellhop run --silent mcp
```

## Remote access over HTTPS

The web service also serves the MCP server at `/mcp` on its own address,
for example `https://bellhop.example.com/mcp`, so an assistant on another
machine can use it. The tools, previews and jobs are exactly the stdio
server's. Every request must carry a credential: a token from signing in
(below), or the API key. A browser session cookie does not count.

**Prerequisites.** Bellhop is reached over HTTPS through your reverse proxy,
on its own subdomain, with web sign-in configured (`configure-web-login`;
see [Web login](authentik.md#web-login)). Bellhop's route is not
forward-auth gated (it signs people in itself), so `/mcp` and the sign-in
paths below pass through as they are. With neither sign-in nor an API key
configured, `/mcp` answers `503` naming both.

### Signing in

Add the server to Claude Code as a remote HTTP server, then authenticate:

```bash
claude mcp add --transport http bellhop https://bellhop.example.com/mcp
```

In Claude Code, run `/mcp`, pick `bellhop`, and choose Authenticate. The
client registers itself with Bellhop and opens your browser on a Bellhop
page that names the client and the address it will return to. Approve it
only if you just asked a client to connect. You then sign in through
Authentik (instantly if you already are), and the browser hands control
back to the client.

- **Admins only.** MCP tools run with full operator trust and do not apply
  the web UI's per-resource permissions, so only members of
  `authentikAdminGroup` or `authentikBuiltinAdminGroup` can sign in. A
  non-admin sees a page saying so, and no token is issued.
- **Access follows Authentik.** The identity behind a token is re-checked
  with Authentik at most every 5 minutes, like a web session. Removing the
  person from the admin groups makes their next request fail with `403`;
  deactivating them, or revoking the sign-in, ends the token.
- **Independent of the browser.** Signing out of the web UI does not end
  MCP access, and the reverse. An access token lasts an hour; the client
  renews it on its own for up to 30 days after sign-in, then you sign in
  again.

Bellhop is the sign-in server for its own MCP endpoint, so these paths
belong to it on Bellhop's address: `/authorize`, `/token`, `/register`,
`/revoke`, `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. Its issuer is the origin of
`webUiOidcRedirectUri`, which must be `https://` (or `http://localhost`
/ `http://127.0.0.1` for local testing; a `http://[::1]` address leaves
sign-in off, API key only).

### API key

For a client that cannot open a browser, use the API key instead. On the
Settings page's **MCP** tab, press Generate, copy the key that appears, and
Save — it is never shown again. (From the CLI:
`bellhop set-config mcpApiKey --stdin --apply`.) Then send it as a header:

```bash
claude mcp add --transport http bellhop https://bellhop.example.com/mcp   --header "Authorization: Bearer <key>"
```

The key has the same operator trust as signing in as an admin. It must be at
least 32 characters with no whitespace. Clear it on the Settings page to
revoke it; `MCP_API_KEY` overrides the stored value.

### Jobs and attribution

Jobs started over HTTP belong to the web service, not to the client: they
keep running when the client disconnects and appear in the web UI like any
other. Each job records who started it and from where — the signed-in
admin (or `api-key`) "via MCP" for HTTP, the operating-system user "via
MCP" for stdio, the signed-in user "via web UI" for the web UI. Several
clients waiting on the same paused job see one prompt dialog between them.
