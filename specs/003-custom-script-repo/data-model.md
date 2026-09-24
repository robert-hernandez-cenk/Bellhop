# Data Model: Custom Script Repository

## Settings (inventory `meta` table, `SettingsSchema`)

| Key | Type | Validation | Notes |
| --- | --- | --- | --- |
| `customScriptsRepo` | string, optional | `owner/repo` (research R7) | Public GitHub repository laid out like ProxmoxVED. |
| `customScriptsBranch` | string, optional | git branch name (research R7) | Resolved to a commit on every app resolution. |

- Both unset: feature off (FR-002).
- Exactly one set: every app resolution throws `<missing key> is not set (<present key> is); set it with "bellhop set-config <missing key> <value> --apply" or on the Settings page, or unset <present key>` (FR-003), e.g. `customScriptsBranch is not set (customScriptsRepo is); set it with "bellhop set-config customScriptsBranch <value> --apply" or on the Settings page, or unset customScriptsRepo`.
- Written by `set-config` and `PATCH /api/settings`, and persisted by `saveInventory`'s existing per-key upsert/delete. No schema migration: `meta` is key/value.

## CustomScriptSource (derived, `src/lib/app-source.ts`)

```text
{ owner: string, repo: string, branch: string, label: "<owner>/<repo>@<branch>" }
```

Returned by `customScriptSource(inventory)`, which returns `undefined` when both settings are unset and throws when only one is set.

## AppSource (resolution result, `src/lib/app-source.ts`)

```text
{
  kind: 'url' | 'upstream' | 'custom',
  slug?: string,              // lowercased bare slug; absent for kind 'url'
  // kind 'custom' only:
  custom?: { owner, repo, branch, label, sha },
  ctUrl?: string,             // https://raw.githubusercontent.com/<owner>/<repo>/<sha>/ct/<slug>.sh
  scriptsBaseUrl?: string,    // https://raw.githubusercontent.com/<owner>/<repo>/<sha>  → COMMUNITY_SCRIPTS_URL
  shadows: ('ProxmoxVE' | 'ProxmoxVED')[]   // empty unless kind 'custom'
}
```

- `url`: `app` contains `://`. Used verbatim, no network access, no export.
- `upstream`: bare slug and either no custom source is configured, or the custom repository returned 404 for `ct/<slug>.sh` at the pinned commit. The existing ProxmoxVE→ProxmoxVED curl fallback is unchanged.
- `custom`: the custom `ct/<slug>.sh` exists at the pinned commit.
- Any failure to pin the commit, or to fetch the custom `ct/` script other than a 404, throws (FR-008).
- Carried on a parsed operation input as the internal field `appSource`. It is never accepted from a request body: `previewAndEnqueue` overwrites it after parsing, and it is not part of any operation `shape`.

## Guest entry (`GuestEntrySchema`, `guests` table)

| Field | Column | Type | Notes |
| --- | --- | --- | --- |
| `appSource` | `app_source TEXT` | `'custom'`, optional | Added with `ensureColumn`. Set only by the web/MCP `install-app` apply when `AppSource.kind === 'custom'`. Carried forward by `upsertGuestEntry` like `app`, and untouched by `sync-inventory`'s merge. |

## Catalog response (`getScriptCatalog`)

Existing `{ stable, dev, fetchedAt, stale }` gains:

```text
custom?: {
  label: "<owner>/<repo>@<branch>",
  slugs: string[],                                  // sorted, lowercased
  shadows: Record<slug, ('ProxmoxVE'|'ProxmoxVED')[]>
}
```

Slugs present in `custom.slugs` are removed from `stable`/`dev` in the response only. The stored upstream catalog is unchanged. `custom` is absent when the feature is off, when the custom listing fails (warning logged), or when the settings are half-configured (warning logged). The catalog must never throw.

## App check response (`checkAppUrl`)

Existing `{ exists, url, dev?, defaults?, prompts? }` gains:

```text
custom?: { label, sha },      // present when resolved to the custom repository
shadows?: ('ProxmoxVE'|'ProxmoxVED')[]   // present and non-empty when overriding upstream
error?: string                // resolution failure (FR-008): exists=false plus a message naming the settings
```

## Inventory API (`GET /api/inventory`)

Adds `customScripts: { repo: string, branch: string } | null`. It's null unless both settings are set. The Dashboard/Update page links use it.
