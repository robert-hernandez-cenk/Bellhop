# MCP server

`npm run mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server
that exposes the toolkit's operations as tools for a local AI assistant.
Every operation tool previews by default and only executes with
`apply: true`; applied work runs as a job you can follow with `wait_for_job`
(or `get_job`). If an installer stops to ask a question, `wait_for_job`
shows it to you as a form when your MCP client supports elicitation. If
your client can't show the form, or you leave it unanswered for 10 minutes,
the assistant sees the question and can answer it with
`answer_job_prompt`.
It manages the inventory and `data/` directory of the checkout it runs from.

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
