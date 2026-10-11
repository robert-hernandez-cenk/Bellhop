# Research: ProxmoxVED → DevScripts

## R1. What the rename looks like on GitHub today

- **Decision**: address `community-scripts/DevScripts` directly in every URL.
- **Rationale**: checked live on 2026-10-11. `gh api repos/community-scripts/ProxmoxVED` returns `full_name: community-scripts/DevScripts` (description "Development Instance of ProxmoxVE!", created 2025-03-03, the same repository). `api.github.com/repos/community-scripts/ProxmoxVED/contents/ct` answers `301` to `/repositories/941908903/contents/ct`, and Node's `fetch` follows that silently. `raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/debian.sh` and `.../DevScripts/main/ct/debian.sh` both return `200`. So Bellhop works today only through GitHub's rename redirect. That redirect breaks permanently if a repository named `ProxmoxVED` is ever created under `community-scripts` again.
- **Alternatives considered**: leave it on the redirect (rejected: latent outage). Resolve the repo id and address `/repositories/<id>` (rejected: the raw host has no id form, and it is less readable).

## R2. Fork network and the operator's fork

- **Decision**: only the upstream side of the compare URL changes: `repos/community-scripts/DevScripts/compare/main...<owner>:<repo>:<sha>`. The head `<owner>:<repo>` stays whatever the operator configured.
- **Rationale**: a rename keeps the fork network, and existing forks keep their own names (an operator fork may still be called `ProxmoxVED`). The fork-network error text now asks "is `<owner>/<repo>` a fork of DevScripts?".

## R3. Persisted data

- **Decision**: no migration.
- **Rationale**: `ShadowedRepo` values (`shadows`, `shadowedBy`) are computed per check or per catalog read. The catalog cache holds slugs grouped as `stable`/`dev`, never a repository name. A guest records only `appSource: 'custom'`, and nothing for upstream installs. `customScriptsRepo` is the operator's own setting and is left alone.

## R4. Captured fixtures

- **Decision**: rewrite `ProxmoxVED` → `DevScripts` in the URL fields of `test/fixtures/github/compare-*.json`.
- **Rationale**: these are redacted live compare responses. Bellhop reads only `status`, `merge_base_commit.sha` and `files[].filename/status` from them, and those fields are unchanged. The URL fields (`html_url`, `blob_url`, ...) name the repository, and a fresh capture would now show `DevScripts` there. The response shape is unchanged, so rewriting the names keeps the fixtures faithful.

## R5. Screenshot

- **Decision**: regenerate `docs/images/install-app-catalog.png` with `npm run docs:screenshots`, and check by eye that its group header reads "DevScripts (development)" and shows example values only.
