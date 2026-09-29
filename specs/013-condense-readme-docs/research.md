# Research: Condense the README into a docs/ folder

## R1. Heading anchors follow GitHub's slug rules

- **Decision**: The link check computes anchors the way GitHub (github-slugger) does. It takes the heading's rendered text: markup is removed, but the text inside inline code and links is kept. It lower-cases that text, removes every character that is not a letter, mark, number, connector punctuation, space or hyphen, and turns each space into a hyphen. A second heading with the same slug gets `-1`, a third `-2`, and so on.
- **Rationale**: Readers click these links on GitHub, so GitHub's rules are the ones that matter. Implementing them takes about 15 lines with Unicode property escapes, so no new dependency is needed.
- **Alternatives considered**: Adding `github-slugger` as a devDependency. It is a correct and small package, but the test can hold the few lines itself, and the repository keeps a short dependency list. Dropping anchor checks and checking only files. Rejected: most seams in this change are anchors.

## R2. What counts as a link

- **Decision**: The check covers inline Markdown links, `[text](target)` and `[text](target "title")`, including image links. It skips fenced code blocks (``` and ~~~) and inline code spans. It skips any target that has a URL scheme (`http:`, `https:`, `mailto:`, ...). `#anchor` alone resolves against the same file, and `path#anchor` resolves the path relative to the linking file. Anchors are checked only when the target is a Markdown file; for any other file the check only confirms it exists (a directory counts too).
- **Rationale**: Every link the README uses today is an inline link. Reference-style links (`[text][ref]`) are not used anywhere, so supporting them would be dead code.
- **Alternatives considered**: A full Markdown parser such as `markdown-it`. Rejected as a new dependency for a narrow check. The skip rules above cover every construct in these files.

## R3. Line budget

- **Decision**: "200 lines or fewer" means the number of lines in `README.md`, not counting the empty string after its final newline.
- **Rationale**: This matches what `wc -l` and an editor report.

## R4. Proxy-driver folder index

- **Decision**: `docs/reverse-proxy/README.md` is the overview page. `caddy.md` and `nginx.md` sit beside it.
- **Rationale**: GitHub renders a folder's `README.md` when the folder is opened, so `docs/reverse-proxy/` works as a link target on its own. Each future driver (#26, #31, #32, #35) adds one file and one index line.

## R5. The one runtime string

- **Decision**: The mobile-consent error hint in `src/commands/networking/sync-authentik.ts` changes from `(README "Authentik API token permissions")` to `(docs/authentik.md "Authentik API token permissions")`. The paragraph's bold label stays exactly "Authentik API token permissions", so the hint still names text the reader will find. The expected string in `test/commands/sync-authentik-mobile-consent.test.ts` changes with it.
- **Rationale**: This is the only user-visible string that names a README section. The other hits (`src/web/auth.ts`, a comment in `sync-authentik.ts`, `inventory/hosts.yaml.example`, CLAUDE.md) are comments or docs.

## R6. Constitution amendment level

- **Decision**: A PATCH amendment, 1.1.0 to 1.1.1, restating "MUST update `README.md`" as "MUST update `README.md` or the relevant page under `docs/`", with Last Amended set to 2026-09-29.
- **Rationale**: This is a wording fix that follows the documentation's new location. What is required does not change: user-visible changes are still documented in the same change.

## R7. Heading levels on the new pages

- **Decision**: Each page opens with a `#` title. The README's `##` sections become the page's `##` sections, and its `###` subsections stay `###`, or become `##` when they are the page's top-level topic. Heading text stays the same wherever that reads correctly, so an anchor keeps its name on the new page.
- **Rationale**: Anchors come from heading text, not heading level, so changing a level never breaks a link.

## R8. Caddy page content

- **Decision**: `docs/reverse-proxy/caddy.md` gathers statements that already exist in the README:
  - Caddy is the default driver.
  - Its config path is `/etc/caddy/Caddyfile`.
  - It replaces only the `bellhop-managed` section and leaves the rest of the Caddyfile untouched.
  - It issues its own certificates through Cloudflare DNS-01, with no extra setup.
  - Its status page follows the opt-in `statusPagePath` setting.
  - `prune-acme-challenges` cleans up after it.

  It links back to the overview for everything the drivers share. The only new text is the connective phrasing.
- **Rationale**: The user chose one page per driver, and Caddy is the default driver. Leaving it without a page would make the default the one driver a reader cannot find.

## R9. Where the content map lives

- **Decision**: `data-model.md` holds the section-by-section map from old README line ranges to new pages. Implementation and review both check against it.
