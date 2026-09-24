# Research: Native OIDC Gating

Phase 0 output for [plan.md](plan.md). Every decision below was checked against the Authentik REST
API schema (`GET /api/v3/schema/`) of a live Authentik 2026.8 instance, read-only. No values from
that instance appear here; example values follow the constitution's Example Data Conventions.

## R1. How the sync recognizes an OpenID client it owns

- **Decision**: An Application backed by an OAuth2 provider is Bellhop's when its slug is an
  inventory candidate slug **and** its `meta_publisher` field equals `bellhop`. The sync sets that
  field when it creates the Application, and the adopt action sets it on a hand-made one.
  Proxy-backed ownership stays exactly as issue #154 left it (slug plus proxy backing, no marker).
- **Rationale**: `meta_publisher` is a free-text field every Application already has and nothing
  in a default Authentik install sets (the live instance: 0 of 9 Applications use it). It survives
  provider swaps because it lives on the Application, and the Application pk is what policy bindings
  hang off, so a mode switch keeps bindings intact. It needs no new storage in Bellhop, matching the
  existing "no Authentik ids persisted in `bellhop.db`" rule.
- **Alternatives considered**: a provider-name prefix (`bellhop-<slug>`) would break the #156 rule
  that the provider name is the bare slug, and a name can be edited by hand to collide. Persisting
  provider pks in the inventory was rejected for the same reason #154 rejected it: the inventory
  would go stale whenever Authentik is edited by hand. Keeping the proxy rule unchanged means
  existing Bellhop-created proxy Applications, which have no marker, are still recognized.

## R2. Required OAuth2 provider settings

- **Decision**: Create with `client_type: confidential`, `grant_types: [authorization_code,
  refresh_token]`, `signing_key` set, `property_mappings` = the managed scope mappings
  `goauthentik.io/providers/oauth2/scope-openid`, `-profile`, `-email`, `redirect_uris` as
  `{ matching_mode: strict, url }` per configured URL, `authorization_flow` and `invalidation_flow`
  from the existing `authentikConfig()` slugs. Provider name is the bare slug (same as #156).
  `client_id`/`client_secret` are left for Authentik to generate.
- **Rationale**: `name`, `authorization_flow`, `invalidation_flow` and `redirect_uris` are the
  schema's required fields. `grant_types` must be sent explicitly (issue #1, note 1: an API-created
  provider otherwise stores `[]` and rejects every authorize request). `refresh_token` is included
  because long-lived app sessions refresh, and every provider on the live instance created through
  the UI has `authorization_code` plus at least one more grant. Scope mappings are looked up by their
  stable `managed` identifier, not by display name, since names are editable.
- **Alternatives considered**: per-entry scope or grant selection is out of scope (spec
  Assumptions). `regex` redirect matching was rejected: strict matching is what the spec's "accepts
  exactly the configured callback addresses" requires.

## R3. Signing key selection

- **Decision**: New optional setting `AUTHENTIK_OIDC_SIGNING_KEY_NAME` in `authentikConfig()`,
  default `authentik Self-signed Certificate`. The sync looks it up with
  `GET /crypto/certificatekeypairs/?name=<name>&has_key=true`. Not found: every OIDC entry in that
  run fails with an error naming the variable, and forward-auth entries still reconcile (FR-015).
- **Rationale**: Same pattern as `AUTHENTIK_AUTHORIZATION_FLOW_SLUG`: a default that matches a stock
  install, overridable per deployment, with a named error instead of a silent fallback.
- **Alternatives considered**: picking "any key with a private key" silently would sign with
  whatever happens to be first, which differs between deployments.

## R4. Reconciling settings on an existing client

- **Decision**: For every owned OAuth2 provider, compare the desired settings from R2 with what
  Authentik returns (grant types and scope mappings compared as sets, redirect URIs as a set of
  `(matching_mode, url)`). Any drift is reported in the dry run as a per-field change and fixed on
  apply with one `PATCH /providers/oauth2/<pk>/`. `client_id` and `client_secret` are never sent in
  a PATCH, so they never rotate (FR-009).
- **Rationale**: This is what makes a callback-address edit apply in place, and the same diff is
  exactly what the adopt preview has to show (FR-011a). One code path serves both.

## R5. Mode switches

- **Decision**: Keep the Application and swap its provider:
  - forward → OIDC: create the OAuth2 provider, `PATCH` the Application's `provider` and set
    `meta_publisher: bellhop`, remove the proxy provider from the embedded outpost, delete the proxy
    provider.
  - OIDC → forward: create a proxy provider, `PATCH` the Application's `provider` and clear
    `meta_publisher`, add the proxy provider to the outpost, delete the OAuth2 provider.
- **Rationale**: Policy bindings target the Application pk, so keeping the Application keeps the
  bindings and the ladder reconcile has nothing to redo. The Application address (slug) never
  changes, matching Story 3 scenario 1.
- **Alternatives considered**: delete and recreate the Application. Simpler code, but it drops and
  re-adds every binding and briefly leaves the app ungated in Authentik.

## R6. Issuer, credentials, and the discovery check

- **Decision**: Credentials come from `GET /providers/oauth2/<pk>/` (`client_id`, `client_secret`)
  and the issuer from `GET /providers/oauth2/<pk>/setup_urls/` (`issuer`). After an apply, the sync
  fetches `<issuer>.well-known/openid-configuration` (issuer ends in `/`) with a 10-second timeout
  and records `ok` or the error per entry. The fetch function is injectable for tests.
- **Rationale**: `setup_urls` is Authentik's own statement of the issuer, so Bellhop never builds
  the URL itself. Reading the secret on demand keeps it out of `bellhop.db` (FR-004). The timeout
  matches `RealCloudflareClient`'s precedent, so a stalled Authentik cannot hang a Dashboard save.

## R7. Where OIDC settings are validated

- **Decision**: Schema: `authMode` is `'forward' | 'oidc'`; `oidcRedirectUris` is an array of
  absolute `http://` or `https://` URLs. The "OIDC mode with an access tier needs at least one
  callback" rule is enforced on **write** (the edit operation and CLI parse helpers) and reported by
  the sync as a skip, but is **not** added to `validateInventory()`.
- **Rationale**: `validateInventory()` runs on every load. The same reasoning that kept ladder
  membership out of it (#158) applies: a hand edit to the database must not make the inventory
  refuse to load. The sync's skip report catches anything that reached the database another way.

## R8. Confirmation for destructive edits

- **Decision**: New edit field `confirmOidcClientDeletion: boolean`. `commitGuestEdit` rejects,
  with a 400-class validation error naming the field, any edit whose current entry is effectively
  OIDC-gated (`authMode: oidc` and an `authGroup`) and whose result is not, unless the flag is true.
  The Dashboard shows a confirmation modal first and sends the flag only after the admin confirms.
  The MCP `edit_guest` tool publishes the same field.
- **Rationale**: One server-side rule for both front ends (Principle IV). Deciding from the
  inventory rather than asking Authentik keeps the edit path free of an extra REST round trip; the
  spec's FR-022a was amended to say so.

## R9. Front-end surfaces

- **Decision**:
  - Web: a new `src/web/routes/oidc.ts` with `GET /api/oidc/:entry/credentials` and
    `POST /api/oidc/:entry/adopt/preview` + `/adopt/apply`, all behind `requireAdminGroup`
    (which reads the impersonation-overlaid groups, so FR-020's impersonation rule holds).
  - CLI: `oidc-credentials <entry>` (read-only) and `adopt-oidc-client <entry> [--apply]`.
  - MCP: `get_oidc_client` returns issuer and client ID only; `adopt_oidc_client` comes from the
    shared operation automatically; `edit_guest` gains the new fields.
  - Adoption is one `Operation` (`adopt-oidc-client`, `fleetWide: true`) in
    `src/operations/networking.ts`, so web, MCP and CLI use the same preview/apply logic.
- **Rationale**: `fleetWide` operations are already admin-only on the web, which is the adoption
  rule. The credential read is not an operation: it changes nothing, so it has no preview/apply pair.

## R10. Reverse-proxy generation

- **Decision**: `buildCaddyBlock` treats an entry as forward-auth-gated only when `authGroup` is set
  **and** `authMode !== 'oidc'`. OIDC entries get the plain reverse proxy, with no `forward_auth`,
  outpost `handle` or `@auth_required` matcher. `validateInventory()`'s "a gated entry needs an
  `authentik: true` entry with an ip" check is narrowed to forward-auth-gated entries, since only
  they route to the outpost.
- **Rationale**: FR-016 and SC-003: forward-auth output stays byte-identical, which existing
  `sync-caddy` tests pin.
