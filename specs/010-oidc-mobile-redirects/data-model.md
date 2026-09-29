# Data model: OIDC mobile-app redirect URIs

## Inventory field

`oidcMobileRedirectUris?: string[]` on `HostEntrySchema`, `GuestEntrySchema` and `ExternalSiteSchema` (`src/lib/inventory.ts`), next to `oidcRedirectUris`.

| Aspect | Rule |
|---|---|
| Item validation | `OidcMobileRedirectUriSchema`: `isValidMobileRedirectUri` (research R1). |
| Storage | New nullable `oidc_mobile_redirect_uris_json TEXT` column on `hosts`, `guests`, `external_sites`, added by `ensureColumn` and included in the `CREATE TABLE` statements for fresh databases. JSON array, or `NULL` when absent/empty. |
| Load | `row.oidc_mobile_redirect_uris_json ? JSON.parse(...) : undefined`, same as `oidcRedirectUris`. A pre-feature database has the column added as `NULL` everywhere, so every entry loads with the field undefined (FR-005). |
| Save | `JSON.stringify` when defined, else `NULL`. Part of the existing wholesale insert. |
| `sync-inventory` | Preserved by its `{ ...existing }` guest merge; hosts are rebuilt from existing entries the same way. No code change expected, but covered by a test. |
| YAML import | Parsed by the same zod schema, so it round-trips with no command change. `inventory/hosts.yaml.example` shows it. |
| Write-time parse | `parseOidcMobileRedirectUris(raw)`: same input forms as `parseOidcRedirectUris` (`;`-joined string or array), deduplicated in authored order, `undefined` when empty, throws naming the first invalid URI and its rejected scheme. |
| Write-time cross-field | `oidcConfigErrors(entry)` adds `oidcMobileRedirectUris: '<uri>' is also a web callback URL; list it in only one` for each URI in both lists (research R2). |
| Mode dependence | Inert unless `effectiveAuth(entry) === 'oidc'`. Never cleared by a mode change. |

## Derived values in `sync-authentik`

- **Client callback set** (per OIDC entry): `clientRedirectUris(entry) = dedupe([...oidcRedirectUris ?? [], ...oidcMobileRedirectUris ?? []])`, all `strict` (research R3).
- **Mobile URI set** (instance-wide): sorted, deduplicated union of `oidcMobileRedirectUris` over gated candidates with `effectiveAuth === 'oidc'` (research R6).

## Mobile consent step (Authentik objects Bellhop owns)

| Object | Identity | Owned when | Desired state |
|---|---|---|---|
| Consent stage | name `bellhop-mobile-app-consent` (`MOBILE_CONSENT_STAGE_NAME`) | its model is the consent stage | `mode: always_require` |
| Flow-stage binding | on the flow with slug `AUTHENTIK_AUTHORIZATION_FLOW_SLUG`, stage = owned stage | its stage is owned | `evaluate_on_plan: false`, `re_evaluate_policies: true` (order `10` on create only) |
| Expression policy | name `bellhop-consent-on-mobile-redirect` (`MOBILE_CONSENT_POLICY_NAME`) | expression policy whose expression starts with `MOBILE_CONSENT_MARKER` | `expression = renderMobileConsentExpression(mobileUriSet)` |
| Policy binding | policy = owned policy, target = the stage binding (either id) | its policy is owned | `enabled`, `failure_result: false` (on create) |

### Lifecycle

```text
          mobile set becomes non-empty
 absent ───────────────────────────────▶ present (4 objects, cache cleared)
   ▲                                        │  set changes → policy PATCHed, cache cleared
   │         mobile set becomes empty       │  drift → PATCHed, cache cleared
   └────────────────────────────────────────┘  (delete: policy binding, binding, policy, stage; cache cleared)
```

A same-named object Bellhop doesn't own puts the step in **conflict**: it's reported, and no object is touched until the operator renames or removes it.

## Sync result addition

`SyncAuthentikResult.mobileConsent?: MobileConsentReport`. It's optional in the type, like the other OIDC-era fields, so hand-built result literals stay valid; `runSyncAuthentik` always fills it.

```ts
interface MobileConsentReport {
  uris: string[];                 // the mobile URI set in effect (sorted)
  changes: MobileConsentChange[]; // planned (dry run) or made (apply)
  conflicts: string[];            // human-readable, one per conflicting object
  error?: string;                 // reconcile failure (research R9)
}
interface MobileConsentChange {
  object: 'stage' | 'binding' | 'policy' | 'policy-binding';
  action: 'create' | 'update' | 'delete';
  detail?: string;                // drifted fields, or the URI count for the policy
}
```
