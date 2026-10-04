# GitHub releases fixtures

Captured live from GitHub's public REST API on 2026-10-03, no authentication,
no redaction needed (public upstream data, not operator data -- constitution
Principle I). `chmln/sd` was chosen because its release list is small and
includes both a draft-free stable release (`v1.1.0`, the current
`/releases/latest`) and several pre-releases (`1.0.0-beta.0`,
`1.0.0-pre-alpha.5`, `1.0.0-alpha.0`), which `fetchLatestRelease`'s
drafts/pre-releases-skipped logic needs to exercise.

| File | How it was produced |
| --- | --- |
| `releases-latest.json` | `curl -s https://api.github.com/repos/chmln/sd/releases/latest -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"` |
| `releases-list.json` | `curl -s "https://api.github.com/repos/chmln/sd/releases?per_page=100" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"` |

Both are stored exactly as returned.
