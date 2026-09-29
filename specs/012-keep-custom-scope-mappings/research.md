# Research: Keep custom scope mappings on an OpenID client

## R1 — The scope-mapping listing's live shape

**Decision**: read the listing from `GET /api/v3/propertymappings/provider/scope/?page_size=100`
(the endpoint `getScopeMappingIds` already calls), and take the truncation count from
`pagination.count`.

**Evidence**: a read-only capture from a live Authentik instance (2026-09-29) returned
top-level keys `pagination`, `results`, `autocomplete` and no top-level `count`. Each result
carries `pk`, `managed` (`null` for a custom mapping), `name`, `expression`, `component`,
`verbose_name`, `verbose_name_plural`, `meta_model_name`, `scope_name`, `description`. The
instance had ten mappings, including a custom one with `managed: null` and
`scope_name: "email"`, which is exactly the case this feature is for.

The existing guard (`res.count > res.results.length`) compared `undefined` to a number,
which is always false, so it never fired. `findPolicyByName` in the same file already
documents that every live list endpoint puts the count under `pagination.count`.

**Fixture**: `test/fixtures/authentik/propertymappings-scope.json`, the capture redacted per
Principle I: every `pk` replaced by an obviously fake UUID, and the custom mapping's `name`,
`description` and `expression` replaced with example values. Built-in mappings keep their
stock names and expressions, which are Authentik's own and carry no operator data.

**Alternatives considered**: a hand-written fixture — rejected by Principle III, and it
would have repeated the `count` mistake.

## R2 — Where the listing is read, and what it returns

**Decision**: replace `AuthentikClient.getScopeMappingIds(managed)` with
`listScopeMappings(): Promise<AuthentikScopeMapping[]>` (`{ id, managed?, scopeName }`).
`resolveOidcInstanceSettings` calls it once and derives both the built-in ids (looked up by
managed id, throwing the same "No Authentik scope property mapping found for managed id
'…'" message when one is missing) and a `scopeNameById` map. It returns both.

**Rationale**: `resolveOidcInstanceSettings` is already called once per sync run (inside
`planOidc`, only when some entry has callback URLs) and once per adoption, so FR-005 holds
without a new call site. The old method has no other caller. A list method keeps the client
a thin mapping of the API, and the "missing managed id" rule moves into the command where
the rest of the OIDC policy lives.

**Alternatives considered**: keeping `getScopeMappingIds` and adding a second listing call
— rejected, it reads the same endpoint twice per run.

## R3 — The drift rule

**Decision**: `diffOAuth2Settings(current, desired, scopeNameById)` gains a required third
argument. The required scope names are the scope names of `desired.propertyMappingIds`
(`openid`, `profile`, `email`). A required scope is covered when some id in
`current.propertyMappingIds` maps to that name in `scopeNameById`. If every required scope is
covered, there is no `property_mappings` change. Otherwise the change is reported and the
patch is `current.propertyMappingIds` (order kept) followed by the desired id of each
uncovered scope.

**Rationale**: deriving required names from the desired ids keeps one source of truth
(`OIDC_SCOPE_MAPPINGS`). An id missing from `scopeNameById` simply covers nothing, which is
FR-006, and it stays in the patch because the patch starts from the current list. Making the
argument required (not optional) means no call site can silently keep the old exact-match
rule.

**Alternatives considered**:
- Putting scope names into `DesiredOAuth2Settings` — rejected: that type is also the create
  payload, and a scope-name field there has no meaning to Authentik.
- Replacing the whole mapping list with "built-ins for missing scopes plus current" in some
  other order — rejected: preserving the existing order means an Authentik UI diff shows only
  the addition.

## R4 — New clients

**Decision**: unchanged. `desiredOAuth2Settings` still puts the three built-in ids on the
create payload; the new rule only affects `diffOAuth2Settings`.

## R5 — Fake client

**Decision**: `FakeAuthentikClient`'s `scopeMappings` seed becomes an
`AuthentikScopeMapping[]` (default: the three built-ins, same ids as today:
`scope-openid-1`, `scope-profile-1`, `scope-email-1`), and it implements `listScopeMappings`.
The one test that seeded a partial map moves to the list form.
