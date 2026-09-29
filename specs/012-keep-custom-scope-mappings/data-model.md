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

`diffOAuth2Settings(current, desired, scopeMappings)` takes either the `scopeNameById` map
or `'exact'`.

With the map (an owned client's drift check, and adoption):

- **Unreadable attached id**: if any id in `current.propertyMappingIds` is absent from
  `scopeNameById`, its scope can't be known (a deleted mapping can't stay attached, so it is
  one the token can't see). `property_mappings` is left alone entirely: no drift, no patch.
- **Covered**: a desired id is covered when it is itself in `current.propertyMappingIds`, or
  when some attached id has the same (known) scope name as the desired id.
- **Fail closed**: a desired id absent from `scopeNameById` is covered only by being attached
  itself.
- **Drift**: at least one desired id is not covered.
- **Patch** (drift only): `current.propertyMappingIds` in order, then each uncovered desired
  id, in `desired` order.

With `'exact'` (an unused provider reused on create, which may be hand-made): the attached
ids must equal the desired ids as a set; otherwise the patch is the desired ids, so the reused
provider ends with exactly the three built-in mappings, like a new client.
