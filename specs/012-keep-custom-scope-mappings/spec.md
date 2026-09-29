# Feature Specification: Keep custom scope mappings on an OpenID client

**Feature Branch**: `issue-16-keep-custom-scope-mappings`

**Created**: 2026-09-29

**Status**: Draft

**Input**: GitHub issue #16 — "sync-authentik/adopt-oidc-client: keep custom scope mappings on an OpenID client instead of replacing them"

## Background

Bellhop gives every OIDC-mode entry an Authentik OpenID client that releases the `openid`,
`profile` and `email` scopes through Authentik's three built-in scope mappings. When it checks
an existing client for drift, today it requires *exactly* those three built-in mappings. Any
other attached mapping is reported as `property_mappings` drift, and the client is put back to
the built-in three.

Some apps need a custom mapping for one of those scopes. The case that surfaced this:
Authentik's built-in `email` mapping always reports `email_verified: false`, and some apps
reject sign-ins that aren't verified, especially sign-ins through a social login source. A
custom `email` mapping, attached to that one app's client only, can derive `email_verified`
from whether the user is linked to the social source. Today such an app cannot be brought
under Bellhop: adoption would replace the custom mapping, and if it were re-attached by hand,
the next sync would replace it again. Either way the app rejects every sign-in.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A synced client keeps its custom scope mapping (Priority: P1)

An operator has a Bellhop-owned OpenID client for an app. They attach a custom `email` scope
mapping to it in Authentik, in place of the built-in one. Every later sync leaves that mapping
in place and reports no drift for it.

**Why this priority**: this is the recurring failure. Every Dashboard edit and every
`sync-authentik --apply` would otherwise revert the mapping and break the app's sign-in.

**Independent Test**: seed an owned OpenID client whose attached mappings are the built-in
`openid` and `profile` mappings plus a custom mapping for the `email` scope, and run a sync
(dry run and apply). No `property_mappings` change is reported or made.

**Acceptance Scenarios**:

1. **Given** an owned client with a custom mapping for `email` and built-in mappings for
   `openid` and `profile`, **When** a sync runs, **Then** no scope-mapping drift is reported
   and the client's mappings are not changed.
2. **Given** an owned client whose mappings cover `openid` and `profile` but no mapping has
   the `email` scope, **When** a sync runs, **Then** `property_mappings` drift is reported,
   and apply adds the built-in `email` mapping while keeping every mapping already attached.
3. **Given** an owned client that also has a mapping for a scope Bellhop does not require
   (for example `offline_access`), **When** a sync runs, **Then** that mapping is left
   attached and does not count as drift.

---

### User Story 2 - Adopting a client with a custom mapping keeps it (Priority: P1)

An operator has a hand-made OpenID client that already uses a custom `email` mapping, and
wants Bellhop to manage it. Adoption marks it as Bellhop's and fixes other real drift, but
leaves the custom mapping alone.

**Why this priority**: without it, the only way to bring such an app under Bellhop breaks the
app during adoption itself.

**Independent Test**: seed an unowned OpenID client that matches Bellhop's desired settings
in every way except a custom `email` mapping in place of the built-in one, and preview
adoption. The preview shows only the ownership-marker change.

**Acceptance Scenarios**:

1. **Given** an adoptable client whose only difference from the desired settings is a custom
   `email` mapping, **When** adoption is previewed, **Then** the preview lists no OpenID
   settings changes, only the ownership marker.
2. **Given** the same client, **When** adoption is applied, **Then** its scope mappings are
   unchanged afterwards.

---

### User Story 3 - New clients are unchanged (Priority: P2)

When Bellhop creates a new OpenID client, it still attaches exactly the three built-in
mappings.

**Why this priority**: a regression guard. The new rule only applies to existing clients.

**Independent Test**: sync an OIDC entry with no client yet; the created client carries
exactly the three built-in mappings.

**Acceptance Scenarios**:

1. **Given** an OIDC entry with no client, **When** a sync applies, **Then** the new client
   has exactly the built-in `openid`, `profile` and `email` mappings.

### Edge Cases

- A client carries two mappings for the same required scope (built-in and custom): the scope
  is covered, and both stay attached.
- A client carries a mapping that the scope-mapping listing does not contain (a deleted
  mapping can't stay attached, so it is one the API token can't see): its scope can't be
  known, so the client's scope mappings are left alone entirely — no drift, no change — rather
  than risk adding a second mapping for a scope it may already cover.
- An unused client reused as a partial-failure self-heal (possibly a hand-made one) is
  treated like a new client: it ends with exactly the three built-in mappings, and any other
  mapping (a custom one, or one for an unrequired scope such as `goauthentik.io/api`) is
  removed.
- The listing of scope mappings reports more mappings than it returned: the run fails with a
  clear message rather than treating the missing ones as absent. This guard exists today but
  read the count from the wrong place, so it never fired.
- A built-in mapping is missing from Authentik entirely: unchanged behavior. Every OIDC entry
  is skipped with the existing "missing scope mapping" reason, even one whose client already
  has a custom mapping for that scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When checking an existing OpenID client (an owned client's drift check, and
  adoption), the scope-mapping check MUST pass when, for each required scope (`openid`,
  `profile`, `email`), its built-in mapping is attached or at least one attached mapping has
  that scope name — built-in or custom. A built-in mapping whose scope name the listing does
  not give counts only when that mapping itself is attached. An unused client reused on
  create MUST instead end with exactly the three built-in mappings, like a new client.
- **FR-002**: Attached mappings for scope names Bellhop does not require MUST be left alone
  and MUST NOT count as drift.
- **FR-003**: `property_mappings` drift MUST be reported only when a required scope has no
  attached mapping. The fix MUST keep every mapping already attached, in its existing order,
  and add the built-in mapping for each missing scope.
- **FR-004**: A new OpenID client MUST still be created with exactly the three built-in
  mappings.
- **FR-005**: The scope-mapping listing MUST be read at most once per sync run, and once per
  adoption, where the built-in mappings are looked up today. The same listing supplies the
  built-in mappings and each mapping's scope name.
- **FR-006**: If any attached mapping id is not in the listing, the client's scope mappings
  MUST be left alone entirely: no drift reported and no change made.
- **FR-007**: The listing's truncated-page guard MUST read the count Authentik actually
  returns, so a truncated listing fails with a clear message.
- **FR-008**: README's "OIDC mode" section and the CLAUDE.md `sync-authentik` bullet MUST
  say that scope-mapping drift is now checked by scope name, and that Bellhop no longer puts
  a built-in mapping back if it is swapped for another mapping with the same scope name.

### Key Entities

- **Scope mapping**: an Authentik property mapping that releases claims for one scope. It
  has an id, a scope name, and, for a built-in one, a stable managed identifier.
- **Required scopes**: `openid`, `profile` and `email` — the scope names of Bellhop's three
  built-in mappings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client with a custom mapping for a required scope shows zero scope-mapping
  changes across repeated syncs, dry run and apply.
- **SC-002**: Adopting a client whose only difference is a custom `email` mapping previews
  exactly one change: the ownership marker.
- **SC-003**: A client missing a required scope is repaired in one apply, and every mapping
  it had before is still attached afterwards.
- **SC-004**: Newly created clients carry exactly three mappings, the built-in ones.
- **SC-005**: A sync run and an adoption each read the scope-mapping listing at most once.

## Assumptions

- Required scopes stay fixed at `openid`, `profile` and `email`. Making them configurable is
  out of scope.
- Bellhop does not create, edit or configure custom mappings. The operator attaches them in
  Authentik.
- Pagination of the scope-mapping listing stays unimplemented. A truncated listing fails
  loudly, as the existing guard intended.
- The test fixture for the listing is a redacted capture of a live response, per the
  constitution's Principle III.
