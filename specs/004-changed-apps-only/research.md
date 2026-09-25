# Research: Custom Script Repository — Only the Apps the Branch Changes

All values below are example values (constitution Principle I). Live captures were
made on 2026-09-24 and redacted before being committed as fixtures.

## R1 — How to learn which apps the branch changes

**Decision**: One call to GitHub's compare endpoint,
`GET /repos/community-scripts/ProxmoxVED/compare/main...<owner>:<repo>:<sha>`, where
`<sha>` is the head commit `resolveHeadSha` already pins. The response's `files[]` lists
every file the head changes relative to the merge base; `ahead_by`/`behind_by` and
`merge_base_commit.sha` come from the same response.

**Rationale**: A single rate-limited request answers "which files differ since the branch
point" exactly, without walking commits. Three-dot semantics are what the issue asks for:
upstream's own later changes are not in the list.

**Alternatives considered**:
- Listing the fork's `ct/` directory (today's behavior): lists every inherited app, which
  is the defect.
- Walking the branch's commits: more requests, and must re-derive the merge base.
- Git trees API diff: two trees of ~1,500 entries each; heavier and still needs the merge
  base.

## R2 — Pin the compare head to a commit, not a branch name

**Decision**: Address the head as `<owner>:<repo>:<sha>`.

**Rationale**: Live probing showed `compare/main...<owner>:ProxmoxVE:main` (a repository the
owner does not have) returned `200` with `status: identical` — GitHub resolved the ref
against a different fork in the same network. A pinned commit either exists in upstream's
fork network or the call 404s. It also makes the compare consistent with the commit every
later step (preview, prompt scan, apply) already reads.

**Alternatives considered**: branch-name head (silently wrong in the case above); an extra
`GET /repos/<owner>/<repo>` call to check `parent`/`source` (costs another rate-limited
request and still leaves the name ambiguity).

## R3 — Changed-set rule

**Decision**: A slug is changed when `ct/<slug>.sh` or `install/<slug>-install.sh` appears in
`files[]` with a status other than `removed`. For `renamed`, only `filename` (the new
name) counts. Files under `json/`, `misc/`, etc. never make an app changed on their own.

**Rationale**: Only those two scripts decide what gets installed. A deletion on the branch
leaves nothing in the fork to install, so the slug must resolve as it otherwise would. A
name renamed away is the same case: it no longer exists in the fork, so counting it would
send the slug to a 404 while upstream still ships it. (Changed from "both names" after
code review.)

## R4 — The 300-file cap

**Decision**: When `files.length >= 300`, throw a named error ("the branch changes too many
files to determine which apps it changes"). Do not page.

**Rationale**: GitHub documents that a comparison's file list stops at 300 files and that
pagination only pages commits; the file list is not recoverable. Acting on a partial list
would silently send changed apps to upstream. A real development branch is nowhere near
this (the captured one changes 9 files).

## R5 — Conflict detection without a reverse compare

**Decision**: Only for a changed slug, and only when `behind_by > 0`: fetch each of the
slug's two scripts from `raw.githubusercontent.com/community-scripts/ProxmoxVED/<ref>/...`
at `<merge-base-sha>` and at `main`. The app conflicts if either file's content differs
between the two (a 404 on one side and 200 on the other counts as different; 404 on both is
the same). A fetch error (not a 404) on the conflict check is logged and treated as no
conflict (spec FR-013).

**Rationale**: The issue proposed a reverse compare (`<branch>...main`). Live, the
captured diverged fork is **251 commits behind**; upstream ProxmoxVED touches far more than
300 files in that span, so the reverse compare's file list would routinely be truncated and
miss conflicts. Raw content is not subject to the API rate limit and has no cap. The cost is
four raw requests per changed app, and zero when the branch isn't behind.

**Alternatives considered**: reverse compare (capped, costs quota); per-file commits API
`?path=&since=` (one rate-limited request per file).

**Live validation**: a public fork of ProxmoxVED, diverged 1 ahead / 251 behind, adds one app
(`demo-wiki` after redaction). At the merge base upstream had neither script (404); upstream
`main` has both (200) — upstream added the same app after the fork point. That is exactly
the conflict the issue describes, and it is the second fixture.

## R6 — Resolving an unchanged slug

**Decision**:
1. Changed → custom at the pinned commit.
2. Otherwise probe upstream ProxmoxVE and ProxmoxVED `ct/<slug>.sh` (the existing
   `detectShadows` probes). If either is present → `kind: 'upstream'` (identical to
   feature-off; the generated script keeps its VE→VED runtime fallback).
3. If a probe *errored* (not a 404) → `kind: 'upstream'` as well: when we can't tell, prefer
   upstream over a possibly stale inherited fork copy.
4. Otherwise probe the fork's `ct/<slug>.sh` at the pinned commit: 200 → `kind: 'custom'`,
   fork-only, no notice; 404 → `kind: 'upstream'` (fails later exactly as feature-off does);
   other status/network error → named error (unchanged from today's custom probe).

**Rationale**: matches the issue's three cases and keeps every upstream app byte-identical to
feature-off. The upstream probes are raw requests, so the only rate-limited requests per
resolution are the head-SHA pin and the compare (spec SC-006).

## R7 — Notices

**Decision**: Replace `formatOverrideWarning` with `formatSourceNotice(source)` returning
`{ level: 'warn' | 'info'; message } | undefined`:
- conflict → `warn`: `"<slug>" changed upstream in ProxmoxVED since <label> branched (merge base <short>); installing the custom copy at commit <short>. Rebase <branch> onto upstream main to pick up the upstream changes.`
- changed + shadows, no conflict → `info`: `"<slug>" comes from the custom script repository <label> (commit <short>) in place of the upstream copy in <repos>.`
- otherwise → `undefined`.

`runInstallApp`/`runUpdateApp` call `logWarn` or `logInfo` accordingly, in the same place the
override warning is logged today, so it stays the first line of the CLI output, captured
preview and job log in every front end.

## R8 — Catalog

**Decision**: `getCustomGroup` pins the head SHA and runs the same compare (shared helper),
producing `slugs = changedSlugs` and `conflicts` (only when behind). `withCustomGroup` keeps
removing those slugs from `stable`/`dev` and computing `shadows`; the response gains
`custom.conflicts: string[]`. The in-memory cache (5 min, keyed by label) and failure
cooldown are unchanged. Cost: 2 rate-limited requests per 5 minutes while the form is in use.

The web popup renders a `conflicts upstream` tag beside a conflicting slug (same pill style as
the existing `overrides …` tag); the check-app response gains `conflict: true`, rendered as a
warning line under the App field. The MCP `list_install_apps`/`check_install_app` tools
return the same JSON.

## R9 — Once-per-operation pinning (spec FR-018)

**Decision**: No change needed in `previewAndEnqueue`: the changed/conflict decision is part
of the `AppSource` it already resolves once and reuses for preview, prompt scan and apply.
