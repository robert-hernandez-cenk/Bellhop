# Data Model: Keep custom scope mappings on an OpenID client

Nothing is persisted by Bellhop. These are the in-memory shapes read from Authentik.

## AuthentikScopeMapping (new, `src/lib/authentik-client.ts`)

| Field | Type | Source | Notes |
| --- | --- | --- | --- |
| `id` | string | `pk` | What an OpenID client's `property_mappings` lists. |
| `managed` | string, optional | `managed` | Set only for a built-in mapping (e.g. `goauthentik.io/providers/oauth2/scope-email`); `null` becomes absent. |
| `scopeName` | string | `scope_name` | The scope the mapping releases claims for. Several mappings can share one. |

## OidcInstanceSettings (changed, `sync-authentik.ts`)

The `ok: true` variant gains `scopeNameById: ReadonlyMap<string, string>` (every listed
mapping's id -> scope name) next to the existing `signingKeyId` and `scopeMappingIds` (the
three built-in ids, in `OIDC_SCOPE_MAPPINGS` order). The failure variants are unchanged.

## Scope coverage rule

- **Required scope names**: `scopeNameById.get(id)` for each id in
  `desired.propertyMappingIds`.
- **Covered**: a required name is covered when some id in `current.propertyMappingIds` has
  that name in `scopeNameById`.
- **Drift**: at least one required name is not covered.
- **Patch** (drift only): `current.propertyMappingIds` in order, then the desired id of each
  uncovered name, in `desired` order.
- An attached id absent from `scopeNameById` is kept and covers nothing.
