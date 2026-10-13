# Quickstart: verify the DevScripts rename

1. `npm run typecheck` and `npm test` pass. The fetch stubs answer only `DevScripts` URLs, so a leftover old-name request fails a test.
2. No old name remains in shipped files (historical specs excluded):
   `git grep -n ProxmoxVED -- ':!specs/003-*' ':!specs/004-*' ':!specs/101-*'` prints nothing.
3. Live, read-only: with the real network, `checkAppUrl` for a development-only slug (the web UI's Install App app check, or MCP `check_install_app`) resolves to `.../community-scripts/DevScripts/main/ct/<slug>.sh`, and `fetchCatalog` lists a non-empty dev group from `community-scripts/DevScripts`.
4. `npm run demo`, then open Install App and type a slug that exists only in the dev group. The suggestion list shows a "DevScripts (development)" group at desktop width and at ≤640px.
5. `npm run docs:screenshots` regenerates `docs/images/install-app-catalog.png`. Check by eye that it shows the new label and example values only.
