# Quickstart: Validating Native OIDC Gating

Phase 1 output for [plan.md](plan.md). Run from the repository root.

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

The suites that cover this feature (all use `FakeAuthentikClient` and temporary inventories):

| Suite | Proves |
|---|---|
| `test/lib/inventory.test.ts` | new fields round-trip; `effectiveAuth`; URL validation; old DBs gain the columns |
| `test/commands/sync-caddy.test.ts` | OIDC entry gets a plain proxy; forward-auth output unchanged |
| `test/commands/sync-authentik.test.ts` | create, idempotency (no credential rotation), in-place updates, mode switches both ways, ownership and conflicts, adoption, skips, discovery reporting |
| `test/operations/edit-guest.test.ts` | confirmation rule; redirect-URI requirement |
| `test/web/routes/dashboard.test.ts` | admin-only `authMode`/`oidcRedirectUris`; impersonation denies |
| `test/web/routes/oidc.test.ts` | credential reveal admin-only and uncached; adopt preview/apply |
| `test/mcp/build-server.test.ts` | `get_oidc_client` never returns the secret; `edit_guest` confirmation |
| `test/cli.test.ts` | `oidc-credentials`, `adopt-oidc-client`, exit codes |

## 2. Dry run against a temporary inventory

```bash
# fixture from the example file, then mark one guest as OIDC
npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path "$TMP/bellhop.db" --apply
INVENTORY_FILE="$TMP/bellhop.db" npm run bellhop -- sync-caddy
```

Expected: the OIDC-mode example entry's site block has `reverse_proxy` and `tls` only.

## 3. Manual verification against a real Authentik (required: `RealAuthentikClient` has no automated test)

Use a throwaway slug (for example `oidc-check`) on a real-inventory copy in the worktree, so nothing
existing is touched. Record the results in the pull request description.

1. Set the throwaway guest to OIDC mode at a ladder rung with callback
   `https://oidc-check.example.com/callback`; run `sync-authentik` (dry run), then `--apply`.
2. In Authentik, confirm the provider has `authorization_code` and `refresh_token` grants, a signing
   key, the three scope mappings, and one strict redirect URI; the Application has
   `meta_publisher = bellhop` and the ladder bindings.
3. Confirm the discovery line reports success, and that a second `--apply` reports no changes.
4. `oidc-credentials <guest>` prints an issuer, client ID and secret matching Authentik's.
5. Change the callback URL; `--apply` updates it and the client ID/secret are unchanged.
6. Switch the guest to forward-auth; the dry run shows the deletion warning; `--apply` swaps to a
   proxy provider on the outpost with the same Application and bindings.
7. Clear the gate and `--apply`; the Application and provider are gone.

## 4. Web UI (desktop and ≤640px viewports)

With `npm run web:dev` and a temporary inventory:

- Advanced modal shows Auth mode and Callback URLs under Auth group; non-admin sees them disabled.
- Revealing credentials shows three values with copy buttons; non-admin sees no reveal control.
- Switching an OIDC guest back to forward-auth opens the confirmation modal; Cancel leaves it unchanged.
- Everything fits at 375px width without horizontal scroll.
