# Research: First-run settings without Authentik

No `NEEDS CLARIFICATION` items came out of Technical Context. The decisions below settle the few design choices.

## R1. Where the Settings nav condition lives

- **Decision**: a pure `adminNavLinks(isAdmin, hasDirectory)` in `web-client/src/lib/admin-nav.ts`. The Sidebar maps over its result.
- **Rationale**: the bug was a visibility condition, and a pure function is testable with `node --test` without adding component-test tooling. The web client already puts testable logic in framework-free modules (`whoami-store.ts`).
- **Alternatives considered**: editing the inline JSX conditions only. That is simpler, but its only coverage would be a browser check.

## R2. Settings still needs only admin, not Authentik

- **Decision**: no server change.
- **Rationale**: `src/web/routes/settings.ts` uses `requireAdminGroup` only, and `requireUserDirectory` is not applied. `test/web/routes/settings.test.ts` already exercises it without Authentik configured. The issue confirmed `GET /api/settings` returns 200 for the local operator.

## R3. Shape of the shared fix phrase

- **Decision**: `settingFix(key, valueHint)` returns `run: bellhop set-config <key> <valueHint> --apply, or set it on the web UI's Settings page`. Callers keep their own leading `<key> is not set --` and any context such as `-- skipping NFS mount discovery`.
- **Rationale**: each message's lead-in already differs (skip vs. fail), so only the fix is shared. Existing tests match the `<key> is not set` prefix, so those assertions keep holding. "web UI's Settings page" names the front end for CLI readers. `app-source.ts` says "on the Settings page" in a message that is only shown alongside other Settings-page context, and it stays out of scope (spec Assumptions).
- **Alternatives considered**:
  - A helper that builds the whole message. The lead-ins vary too much for that.
  - Also naming the MCP server. It has no settings tool; `set-config` is exposed there as an operation, so the CLI wording already covers it.

## R4. Derived-value empty states: client or server

- **Decision**: client-side text in `web-client/src/lib/settings-display.ts`. The API response stays `{ lanGateways: [], caddy: null }`.
- **Rationale**: FR-011 forbids an API shape change, and the server already returns enough information. A `caddy: true` entry without an IP maps to `null` on the server too, so the empty-state wording says "with an IP" to stay true for that edge case (spec Edge Cases).

## R5. README placement

- **Decision**: add a short "Inventory-wide settings (before your first sync)" step at the end of Setup, after the import step. It links to the full "Inventory-wide settings" section instead of moving that section. It shows `bellhop set-config nfsServer <ip> --apply` and mentions the Settings page.
- **Rationale**: the full section is long, it is a reference table, and other sections link to it by name. A short step in Setup fixes the ordering a newcomer follows without breaking those links.
