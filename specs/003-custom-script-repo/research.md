# Research: Custom Script Repository as a First-Class App Source

All findings below were checked against live upstream sources on 2026-09-24. Raw responses used as test fixtures are saved under `test/fixtures/github/`. They are public community-scripts data and contain no operator values.

## R1. How a ProxmoxVED-shaped `ct/` script decides where its install script comes from

- **Decision**: For an app resolved to the custom repository, Bellhop exports `COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/<owner>/<repo>/<sha>` before `bash -c "$(curl … ct/<slug>.sh)"`, for both `install-app` and `update-app`. For ProxmoxVE/ProxmoxVED apps it exports nothing new.
- **Rationale**: Both upstream repos' `ct/` scripts now source a shared engine, `community-scripts/core`'s `core/build.func`. That engine resolves every non-engine path (`ct/…`, `install/…`) against `COMMUNITY_SCRIPTS_URL` (`_cs_remote_url`), and fetches the per-app installer with `_cs_fetch_text "install/${var_install}.sh"` (`pve/backend.func`). The fallback order is `COMMUNITY_SCRIPTS_URL` → a local git checkout's origin (only when `BASH_SOURCE` is a real file, which it never is under `bash -c "$(curl …)"`) → `_CS_DEFAULT_URL`. A ProxmoxVE `ct/` script sets `_CS_DEFAULT_URL` to `…/ProxmoxVE/main` itself, and the engine's own default is `…/community-scripts/ProxmoxVED/main`. `host/source-origin.func` states "Explicit COMMUNITY_SCRIPTS_URL / COMMUNITY_SCRIPTS_DIR overrides always win." `pve/backend.func` exports `COMMUNITY_SCRIPTS_URL` into the container environment, so the in-container install run reads the same base. Without the export, a fork's `ct/` script would install upstream ProxmoxVED's `install/<slug>-install.sh`, or fail when upstream has none.
- **Consequence**: The engine's `write_update_entrypoint` bakes `COMMUNITY_SCRIPTS_URL` into the container's own `/usr/bin/update`. A custom-installed container's built-in `update` command is therefore pinned to the install commit. Bellhop's `update-app` re-resolves and re-exports the current head commit, and the engine regenerates `/usr/bin/update` on every successful update, so updating through Bellhop moves it forward. The in-container helper also asks community-scripts.org whether the app can be updated, and the site doesn't know fork-only apps. Bellhop's `update-app` bypasses that helper because it curls `ct/<slug>.sh` directly. Both points are recorded as known limitations in README.
- **Alternatives considered**: Exporting a branch URL instead of a commit keeps `/usr/bin/update` on the branch, but reintroduces the 5-minute CDN staleness (R3) and a preview/apply mismatch. Rejected per the clarified decision. Rewriting the downloaded `ct/` script's `_CS_DEFAULT_URL` was also rejected: that value only matters when `COMMUNITY_SCRIPTS_URL` is unset, and editing script text is fragile.

## R2. Resolving a branch to its head commit

- **Decision**: `GET https://api.github.com/repos/<owner>/<repo>/commits/<branch>` with `Accept: application/vnd.github.sha` and `User-Agent: bellhop`. On success it returns a bare 40-hex SHA as plain text (fixture `branch-head-sha.txt`).
- **Error shapes** (captured): an unknown branch returns 422 `{"message":"No commit found for SHA: <branch>",…}` (`branch-head-missing-branch-422.json`). An unknown or private repo returns 404 `{"message":"Not Found",…}` (`branch-head-missing-repo-404.json`). Both become an error naming the configured `customScriptsRepo`/`customScriptsBranch` and the `set-config` command. A 403/429 (rate limit), a timeout, or a non-hex body becomes the same kind of named error, without falling back to upstream (FR-008).
- **Rationale**: This is one small request, it needs no JSON parsing, and it works for branch names containing `/` (URL-encoded).
- **Alternatives considered**: `GET /repos/{o}/{r}/branches/{b}` returns a large JSON object for the same SHA. `git ls-remote` would need a git binary on the Bellhop host. Both rejected.

## R3. Raw CDN caching

- **Finding**: `raw.githubusercontent.com` serves branch URLs with `cache-control: max-age=300`. Commit-SHA URLs are immutable.
- **Decision**: Every custom-repository raw URL Bellhop builds or hands to the engine uses the pinned SHA, never the branch name.

## R4. Listing the custom repository's `ct/` directory for the catalog

- **Decision**: `GET https://api.github.com/repos/<owner>/<repo>/contents/ct?ref=<branch>`, which is the endpoint `script-catalog.ts` already uses for upstream, plus `ref`. The captured shape (`contents-ct-listing.json`, 67 entries from ProxmoxVED `main`) is an array of `{name, path, sha, size, url, html_url, git_url, download_url, type, _links}`, and it includes directories (`deferred`, `headers`) that the existing `.sh`/`type` filter already drops.
- **Caching**: in-process memory only, keyed by `<owner>/<repo>@<branch>`, with a 5-minute TTL (`CUSTOM_CATALOG_MAX_AGE_MS`). Changing either setting changes the key, so the old listing is never served (FR-010). A failed fetch returns no custom group, logs a warning (FR-011), and starts a short cooldown, the same as the existing `lastFailureAt` pattern.
- **Rationale**: A persisted copy only helps when GitHub is down, and at a 5-minute TTL it would be stale anyway. Keeping it out of SQLite avoids migrating `script_catalog`'s `CHECK (repo IN ('stable','dev'))`, since SQLite cannot alter a CHECK constraint without rebuilding the table. The web service, CLI and MCP server each keep their own copy, which costs at most one extra GitHub call per process every 5 minutes.
- **Alternatives considered**: A third `repo` value in `script_catalog` (needs a table rebuild, and would mix two TTLs in one table). A sibling table (persistence with no real benefit). Both rejected.

## R5. Where resolution and pinning live in the call graph

- **Decision**: One async resolver, `resolveAppSource(app, inventory, fetchImpl)` in a new `src/lib/app-source.ts`, returns an `AppSource` (see data-model.md). `runInstallApp`/`runUpdateApp` accept an optional pre-resolved `source` and call the resolver themselves only when it's absent. `previewAndEnqueue` resolves once for operations flagged `resolvesApp` (`install-app`, `update-app`), stores the result on the parsed input as the internal field `appSource`, and derives the expected-prompt pre-scan from that same source. `preview()` and the job's `apply()` therefore read the same commit.
- **Rationale**: Today the web/MCP apply path resolves up to three times (preview, prompt pre-scan, and apply inside the job, which can start much later). Resolving once per operation is what makes FR-005/SC-004 hold. The CLI runs dry-run and `--apply` as separate invocations and resolves in each. That matches how it treats every other live lookup (authorized_keys, NFS paths), and is documented.
- **Alternatives considered**: Having the web check endpoint return the SHA and making the client send it back with Apply. Rejected: it adds a client-held value that MCP callers would also have to thread through, and a check done minutes earlier is exactly the staleness pinning exists to avoid.

## R6. Shadow detection

- **Decision**: Only when a slug resolves to the custom repository does the resolver also probe `…/ProxmoxVE/main/ct/<slug>.sh` and `…/ProxmoxVED/main/ct/<slug>.sh` (GET, same as `checkAppUrl`) and record each hit in `shadows`. A failed probe is treated as "not present" and logged. The override warning is informational, and a flaky upstream probe must not block a custom install.
- **Warning text** (one `logWarn`, emitted by `runInstallApp`/`runUpdateApp` before anything else, so it lands at the top of CLI output, the captured preview and the job log): `"<slug>" is installing from the custom script repository <owner>/<repo>@<branch> (commit <short-sha>), which overrides the upstream copy in <ProxmoxVE[, ProxmoxVED]>. Unset customScriptsRepo/customScriptsBranch with set-config to use upstream.`

## R7. Settings validation

- **Decision**: `customScriptsRepo`: `^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$` (GitHub owner and repo name rules). `customScriptsBranch`: `^[A-Za-z0-9._/-]+$`, rejecting `..`, a leading `/` or `-`, and a trailing `/` or `.lock`. The both-or-neither rule is enforced at the point of use (`customScriptSource()`), not in `SettingsSchema`, because `set-config` writes one key at a time and a cross-field schema rule would make it impossible to set the first key.

## R8. Provenance and the Dashboard link

- **Decision**: New optional guest field `appSource: 'custom'` (a `guests.app_source` column, added by `ensureColumn`), written only by the web/MCP install apply path when the source is custom and carried forward by `upsertGuestEntry` the same way `app` is. `GET /api/inventory` adds `customScripts: { repo, branch } | null`. `communityScriptsUrl(guest, customScripts)` in `web-client/src/lib/guest-display.ts` returns `https://github.com/<owner>/<repo>/blob/<branch>/ct/<slug>.sh` for a custom guest, `undefined` when the custom settings are now unset, and the existing community-scripts.org link otherwise.
- **Alternatives considered**: Recording `'ve' | 'ved'` as well, which the web path could learn from `checkAppUrl`'s `dev` flag. Rejected as YAGNI (spec FR-012): nothing reads it, and the existing link already works for both.
