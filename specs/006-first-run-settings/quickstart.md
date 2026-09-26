# Quickstart: validating first-run settings without Authentik

All paths are relative to the worktree root.

## 1. Automated checks

```bash
npm run typecheck
npm test
```

Expected: both pass. The new tests are `test/lib/settings-hint.test.ts`, `test/web-client/admin-nav.test.ts`, and `test/web-client/settings-display.test.ts`, and the tightened message assertions in `test/commands/` pass.

## 2. Unset-setting message (CLI, no real infrastructure)

Build a temp fixture with no `nfsServer`:

```bash
npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path <tmp>/bellhop.db --apply
INVENTORY_FILE=<tmp>/bellhop.db npm run bellhop -- migrate-nfs-mount --host <any-lxc-in-example> --storage x
```

Expected: the error reads `nfsServer is not set -- run: bellhop set-config nfsServer <ip> --apply, or set it on the web UI's Settings page`.

## 3. Browser: no-Authentik mode, fresh inventory

Start the web UI against a fixture with no `caddy: true` entry and no `midScheme`. Use no `data/authentik.env`, and don't set `WEB_UI_DEV_USER` or `WEB_UI_AUTH_MODE`, so the local operator is used:

```bash
INVENTORY_FILE=<tmp>/bellhop.db PORT=3001 npx tsx src/web/server.ts   # plus: npm run dev --prefix web-client
```

Check at desktop width and at ≤640px (drawer open):

- The sidebar shows an **Admin** label with only **Settings**. Users and Permissions are absent.
- Settings opens the page. The intro says every setting is optional, and each field shows an "Optional" marker.
- The derived section reads "LAN gateways: none yet — no host has a midScheme" and "Caddy host (firewall scope): not set — no inventory entry has caddy: true with an IP yet".
- Nothing overflows at 640px or narrower.

## 4. README

In Setup, a settings step (mentioning `nfsServer`, `set-config`, and the Settings page) appears before any `sync-inventory` instruction. "Running without Authentik" says Settings remains.
