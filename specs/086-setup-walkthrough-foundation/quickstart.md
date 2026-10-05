# Quickstart: validating the setup walkthrough foundation (#86)

## Automated

```bash
npm run typecheck
npm test            # includes test/lib/setup-state.test.ts, test/lib/bellhop-key.test.ts,
                    # test/lib/mid-suggest.test.ts, test/web/setup/*.test.ts,
                    # test/scripts/demo/seed-db.test.ts, and the domain-as-setting tests
npm run web:build
```

## Fresh install against the demo SSH layer (no real hosts)

1. Start the web service against an empty temp inventory and data directory:
   `INVENTORY_FILE=<tmp>/bellhop.db WEB_DATA_DIR=<tmp>/data npm run web:dev`.
2. The log shows `Setup is pending: open http://localhost:<port>/setup?token=<token>`.
3. Opening `/` redirects to `/setup`, which says to open the setup address. `curl /api/inventory` answers 503 `setupRequired`.
4. Opening the logged address lands on step 1, and the address bar shows `/setup` without the token.
5. Restarting the service logs the same token.

Against real Proxmox, step 1 needs a reachable node. Use a lab node, never production, unless the operator runs it.

## Step 1 (real Proxmox lab node, manual)

1. Generate a key, then install it with the root password. The node's `authorized_keys` gains one `… bellhop` line, and repeating the install leaves one line.
2. Test: shows the node name and Proxmox version.
3. Save host: the host appears under its node name with bridges and storage. A cluster lists its peers.
4. Accept or edit the suggested `midScheme`, then save.
5. Re-run the save for the same host: still one host, guests intact.

## Step 2 and finish

1. Save `domain=example.com`, plus optional values. An invalid domain is refused with the field named.
2. Finish: lands on the Dashboard. `/setup?token=<old>` no longer authorizes, and `/api/setup/state` answers 404.
3. Restart: no setup line in the log, and the Dashboard is served.

## Domain as a setting

- `npm run bellhop -- set-config domain example.net --apply` changes it.
- `set-config domain not_a_domain --apply` is refused with "must be a domain name such as example.com".
- With a guest that has subdomains, `set-config domain --unset --apply` is refused, naming the subdomain rule.
- The Settings page shows and edits `domain`.

## Removal

- `npm run bellhop -- import-yaml-inventory` is an unknown command.
- `npm run demo:seed -- <tmp>/demo.db` writes a database that `loadInventory` accepts (asserted by `test/scripts/demo/seed-db.test.ts`). Running it again without `--force` refuses to overwrite.

## Browser checks (required for UI changes)

The setup page at desktop width and at 375px: step list, forms, public-key box (wraps, copyable), errors and peer list, with no horizontal overflow. Repeat for the Settings page's new domain field.
