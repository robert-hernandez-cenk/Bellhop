# Data Model: Custom Script Repository — Only the Apps the Branch Changes

No inventory or database schema changes. Every entity here is in-memory, derived per
resolution or per catalog read.

## BranchComparison (new, `src/lib/app-source.ts`)

The parsed result of one compare call for a pinned custom branch.

| Field | Type | Notes |
| --- | --- | --- |
| `sha` | string (40 hex) | The pinned head commit the compare was made against. |
| `mergeBase` | string (40 hex) | `merge_base_commit.sha`. |
| `aheadBy` | number | `ahead_by`. |
| `behindBy` | number | `behind_by`; `0` skips conflict checks entirely. |
| `changedSlugs` | `Set<string>` | Per research R3. Lowercase, as filenames are. |

Validation: the compare response is parsed with a `zod` schema (only the fields above plus
`files[].filename/status`); a schema mismatch is a named error.
`files.length >= 300` is a named error (research R4).

## AppSource (extended)

Existing fields unchanged (`kind`, `slug`, `custom`, `ctUrl`, `scriptsBaseUrl`, `shadows`).
New fields, set only for `kind: 'custom'`:

| Field | Type | Notes |
| --- | --- | --- |
| `changed` | boolean | `true` when the slug is in `changedSlugs`; `false` for a fork-only resolution. |
| `conflict` | boolean | `true` only when `changed`, `behindBy > 0`, and upstream changed either script since the merge base. |
| `custom.mergeBase` | string | Carried for the conflict notice text. |

Resolution states (research R6):

```text
bare slug, feature on
 ├─ in changedSlugs ───────────────► custom { changed: true, conflict?, shadows }
 ├─ upstream VE/VED has it (or probe error) ► upstream (feature-off identical)
 ├─ fork ct/<slug>.sh at sha = 200 ► custom { changed: false, conflict: false, shadows: [] }
 └─ fork 404 ──────────────────────► upstream (fails as feature-off does)
```

## SourceNotice (replaces the override-warning string)

`{ level: 'warn' | 'info'; message: string } | undefined` — see research R7 for wording.

## Catalog response (extended)

`custom` gains `conflicts: string[]` (subset of `slugs`). `slugs` is now the changed set, not
the fork's whole `ct/` listing.

## App check response (extended)

`checkAppUrl`/`GET …/check-app`/MCP `check_install_app` gain `conflict?: true` on a custom
resolution that conflicts.
