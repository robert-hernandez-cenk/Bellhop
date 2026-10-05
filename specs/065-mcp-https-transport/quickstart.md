# Quickstart: validating MCP over HTTPS

## 1. Automated

```bash
npm run typecheck
npm test            # includes test/mcp/http-*.test.ts and test/web/mcp-auth*.test.ts
npm run web:build
```

## 2. Local, API key only

1. `npm run web:start` with a fixture inventory (`INVENTORY_FILE=...`).
2. Settings → **MCP** → Generate → copy → Save. Reload: the page shows "set", never the value.
3. `curl -i -X POST http://localhost:3001/mcp` → `401`.
4. Add to an MCP client: URL `http://localhost:3001/mcp`, header `Authorization: Bearer <key>`. `get_inventory` works.
5. Wrong key → `401`. Clear the key with sign-in unconfigured → `503` naming both fixes.

## 3. Deployed, sign-in (manual, real infrastructure)

1. Bellhop reachable at `https://bellhop.example.com` with web sign-in configured (`configure-web-login`).
2. `claude mcp add --transport http bellhop https://bellhop.example.com/mcp`, then `/mcp` in Claude Code → Authenticate. The browser shows Bellhop's consent page naming the client; approve; Authentik sign-in; the browser reports success.
3. Run a preview tool, then an `apply` that starts a job. The web UI's job list shows your username with "MCP".
4. Sign out of the web UI in the browser: the MCP client keeps working.
5. As a non-admin account: the flow ends on "MCP access is limited to Bellhop admins".
6. Start an `install-app` that prompts; answer in Claude Code's dialog; disconnect; the job finishes and is visible in the web UI.

## 4. Mobile

Settings → MCP tab at ≤640px: the key field, Generate and Save fit without overflow.
