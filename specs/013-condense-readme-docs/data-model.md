# Content Map: README sections to docs/ pages

Line numbers refer to `README.md` at `origin/main` 58c8b70 (1,166 lines). Every row moves verbatim except for the seams (see [contracts/docs-layout.md](contracts/docs-layout.md)).

| Old README lines | Old heading | New location |
|---|---|---|
| 1-13 | intro | stays in `README.md` (the "Reverse proxy drivers below" pointer becomes a link to `docs/reverse-proxy/`) |
| 15-24 | Prerequisites | stays in `README.md` |
| 26-47 | Setup (install, first import) | stays in `README.md` as the quickstart |
| 49-63 | Setup: hand-editing `hosts.yaml` schema notes | `docs/configuration.md`, "Hand-editing the inventory" |
| 65-82 | Inventory-wide settings (before your first sync) | the command stays in the README quickstart; the full text moves to `docs/configuration.md`, "Inventory-wide settings (before your first sync)" |
| 84-312 | Usage (Maintenance, Provisioning, Networking) | `docs/commands.md` |
| 314-389 | Reverse proxy drivers | `docs/reverse-proxy/README.md` |
| 391-478 | nginx driver | `docs/reverse-proxy/nginx.md` |
| 480-503 | Upgrading an existing installation | `docs/reverse-proxy/README.md`, "Upgrading from the Caddy-only version" |
| 505-687 | OIDC mode (including token permissions, the mobile consent step, the Access tab and the signing key) | `docs/authentik.md`, "OIDC mode" |
| 689-742 | Web UI | `docs/web-ui.md` |
| 744-802 | MCP server | `docs/mcp-server.md` |
| 804-843 | Inventory-wide settings | `docs/configuration.md` |
| 845-944 | Custom script repository | `docs/configuration.md` |
| 946-953 | Derived values (`set-guest-vpn --vpn none`, firewall scope) | `docs/configuration.md` |
| 955-1091 | Environment variable overrides | `docs/environment-variables.md` |
| 1093-1114 | Running without Authentik | `docs/authentik.md` |
| 1116-1125 | Validation | `docs/troubleshooting.md` |
| 1127-1144 | Known hardware issues | `docs/troubleshooting.md` |
| 1146-1150 | Further reading (CLAUDE.md) | a line in the README's Documentation index |
| 1152-1166 | Contributing, Security, License | stay in `README.md` |

New, gathered rather than moved: `docs/reverse-proxy/caddy.md`, built from Caddy statements in lines 314-389, 804-843 and 1083-1091 (see research R8).

## Pointers outside the README

| File | Current pointer | New pointer |
|---|---|---|
| `src/commands/networking/sync-authentik.ts` (error hint, about line 283) | `README "Authentik API token permissions"` | `docs/authentik.md "Authentik API token permissions"` |
| `src/commands/networking/sync-authentik.ts` (comment, about line 984) | `README "Authentik API token permissions"` | `docs/authentik.md` |
| `test/commands/sync-authentik-mobile-consent.test.ts` (about line 224) | expected hint string | updated to match |
| `src/web/auth.ts` (comment, line 46) | README's "Running without Authentik" | `docs/authentik.md` |
| `inventory/hosts.yaml.example` (lines 97-98) | README's "OIDC mode" section | `docs/authentik.md`'s "OIDC mode" section |
| `CLAUDE.md` | README's "OIDC mode"; "limitations in README"; "Running without Authentik" in `README.md` | `docs/authentik.md`, `docs/configuration.md`, `docs/authentik.md` |
| `CONTRIBUTING.md` (line 136) | updates `README.md` | updates `README.md` or the relevant `docs/` page |
| `.github/pull_request_template.md` (line 18) | `README.md` / `CLAUDE.md` updated | `README.md` / `docs/` / `CLAUDE.md` updated |
| `.specify/memory/constitution.md` (line 105) | MUST update `README.md` | MUST update `README.md` or the relevant page under `docs/` (1.1.1) |
| `CONTRIBUTING.md` (lines 24-27) | `README.md#prerequisites`, `README.md#setup`, "first-time inventory step" | unchanged; the headings and the step stay in the README |
