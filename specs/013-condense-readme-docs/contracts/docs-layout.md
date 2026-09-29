# Contract: Documentation layout

## README.md (≤ 200 lines), sections in order

1. `# Bellhop`: intro paragraph and the Proxmox trademark notice.
2. `## Prerequisites`: unchanged heading (CONTRIBUTING.md links to `#prerequisites`).
3. `## Setup`: unchanged heading (CONTRIBUTING.md links to `#setup`). A quickstart that can be followed without leaving the page:
   1. `npm install` (and the optional `npm link`).
   2. Create the inventory from `inventory/hosts.yaml.example` with `import-yaml-inventory`, and point to `docs/configuration.md` for hand-editing real hosts.
   3. `set-config nfsServer <ip> --apply`, and point to `docs/configuration.md` for the other settings.
   4. `sync-inventory`, then `sync-inventory --apply`.
   5. Start the web UI (`npm run web:build`, then `npm run web:start`), and point to `docs/web-ui.md`.
4. `## Commands`: a table of 10 to 15 rows (command, what it does), linking to `docs/commands.md`. Every mutating command's row notes that `--apply` is needed.
5. `## Documentation`: one line per page, linking each of the ten pages below plus `CLAUDE.md`.
6. `## Contributing`, `## Security`, `## License`: unchanged.

## docs/ pages

| Page | Title |
|---|---|
| `docs/commands.md` | Commands |
| `docs/configuration.md` | Configuration |
| `docs/environment-variables.md` | Environment variables |
| `docs/web-ui.md` | Web UI |
| `docs/mcp-server.md` | MCP server |
| `docs/authentik.md` | Authentik |
| `docs/troubleshooting.md` | Troubleshooting |
| `docs/reverse-proxy/README.md` | Reverse proxy drivers |
| `docs/reverse-proxy/caddy.md` | Caddy driver |
| `docs/reverse-proxy/nginx.md` | nginx driver |

Each page opens with `# <Title>` and a one-sentence statement of what it covers, then the moved content.

## Seam rules (the only rewording allowed)

- "see "X" above/below" becomes a relative link to X's new page and anchor, e.g. `see [Inventory-wide settings](configuration.md#inventory-wide-settings)`.
- "(see below)" or "see Web UI above", pointing at a section that is now on another page, becomes a link to that page.
- A sentence that only made sense because of its README position (e.g. "A browser dashboard for everything above") is adjusted to name what it refers to.
- Nothing else is reworded, reordered within a section, or dropped.
