# Quickstart: Keep custom scope mappings on an OpenID client

## Automated

From the worktree root:

```bash
npm run typecheck
npm test
```

The scenarios below are covered by tests in `test/commands/sync-authentik.test.ts`,
`test/commands/adopt-oidc-client.test.ts` and `test/lib/authentik-client.test.ts`:

1. Owned client with a custom `email` mapping plus built-in `openid`/`profile`: dry run and
   apply report no `oidcUpdates`, and the client's mappings are unchanged.
2. Owned client with no `email`-scope mapping: `oidcUpdates` lists `property_mappings`; after
   apply the client holds its previous mappings followed by the built-in `email` one.
3. Owned client with an extra `offline_access` mapping: no drift; it stays attached.
4. Adoptable client differing only by a custom `email` mapping: the preview has no OpenID
   settings changes, only the marker; after apply its mappings are unchanged.
5. New OIDC entry: the created client has exactly the three built-in mappings.
6. `RealAuthentikClient.listScopeMappings` against the redacted fixture maps `pk`/`managed`/
   `scope_name`, and throws when `pagination.count` exceeds the returned results.

## Manual (real Authentik, read-only)

With a real `data/authentik.env`, a dry run shows the effect on the live instance without
changing anything:

```bash
npm run bellhop -- sync-authentik
```

An owned OIDC client carrying a custom mapping for `openid`, `profile` or `email` must not
appear under `OpenID client settings to update` with `property_mappings`.
