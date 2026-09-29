# Quickstart: validating OIDC mobile redirect URIs and the consent step

All commands run from the worktree root. Paths and hosts are examples.

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

These must all pass. The feature's own tests live in:

- `test/lib/inventory.test.ts`: schema, parse, `oidcConfigErrors` cross-list rule, round-trip, pre-feature DB loads unchanged
- `test/commands/sync-authentik.test.ts`: client callback set = web ∪ mobile; the consent step's create, update, remove, conflict, drift, dry-run parity, failure isolation, and `syncAuthentikFailed`
- `test/commands/mobile-consent-expression.test.ts` (or a section of the above): `pythonStringLiteral` and `renderMobileConsentExpression` quoting, including quotes, backslashes, newlines, non-ASCII and astral characters
- `test/lib/authentik-client.test.ts`: the new `RealAuthentikClient` methods against redacted live fixtures
- `test/operations/edit-guest.test.ts`, `test/web/routes/dashboard.test.ts`, `test/mcp/build-server.test.ts`: edit surfaces and the admin gate
- `test/commands/adopt-oidc-client.test.ts`: adoption includes mobile URIs
- `test/commands/import-yaml-inventory.test.ts`: YAML round-trip
- `test/web-client/access-fields.test.ts`: `accessFieldsFor`, run by the same `npm test`

## 2. Dry run against a temp inventory (no infrastructure)

```bash
tmp=$(mktemp -d)
INVENTORY_FILE=$tmp/bellhop.db npm run bellhop -- import-yaml-inventory \
  --yaml-path inventory/hosts.yaml.example --db-path $tmp/bellhop.db --apply
```

The example file carries `oidcMobileRedirectUris` on its OIDC example guest. The imported database must contain it; check with `get_inventory` or a `loadInventory` script.

## 3. Web UI (desktop and ≤640px)

1. `npm run web:dev`, and open the Dashboard.
2. Open Advanced on a forward-mode guest. The General tab is selected. On the Access tab, confirm auth group, auth mode and unauthenticated paths are shown, and no callback/mobile/OIDC client rows.
3. Switch auth mode to OIDC and save. The Access tab now shows callback URLs, mobile app redirect URLs (with its help line) and the OIDC client row, and hides unauthenticated paths.
4. Enter `app.example:///oauth-callback` in mobile app redirect URLs and save. Then enter `javascript:alert(1)` and confirm the save is refused with a message naming it.
5. Switch back to forward mode. Unauthenticated paths reappear with their earlier value, and switching to OIDC again shows the mobile URL still there.
6. Repeat 2–5 with the browser at 390px width. The tabs and fields must fit with no horizontal scroll.

## 4. Live Authentik (manual; needs the operator)

Against the deployment's Authentik, with one OIDC-mode app that has a native Android client:

1. Add the app's mobile redirect URI (from its docs, e.g. `https://books.example.com/auth/openid/mobile-redirect`).
2. `npm run bellhop -- sync-authentik` (dry run). It must list the OpenID client's `redirect_uris` update and the four consent-step creates.
3. `npm run bellhop -- sync-authentik --apply`, then run the dry run again. The second dry run must report no changes (SC-005).
4. In Authentik's admin UI, confirm the authorization flow has `bellhop-mobile-app-consent` bound with "Evaluate when flow is planned" off and "Evaluate when stage is run" on, and the policy bound to that binding.
5. On the phone, with an existing Authentik session, sign in from the app. Expect one consent page, then the app opens.
6. In a desktop browser, sign in to the same app. Expect no consent page.
7. Remove the mobile URI, run `sync-authentik --apply`, and confirm the four objects are gone (SC-004).
8. If the flow still carries a hand-made consent stage or policy from before this feature, delete it; otherwise mobile logins show two consent pages.
