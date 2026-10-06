# Research: Audience-Named Default Group Ladder

## R1 — Ladder order

- **Decision**: `bellhop-public-readonly` < `bellhop-public` < `bellhop-friends-family` < `bellhop-admin-family` < `authentik Admins`.
- **Rationale**: An entry gated at a rung binds that rung and every rung above it (`rungsAtOrAbove`). A member of the lowest rung therefore reaches only apps gated at the lowest rung — the fewest apps — which is what "most constrained" means for `public-readonly`. Each renamed rung keeps its old position relative to the others.
- **Alternatives considered**: Putting `public-readonly` above `public` — rejected: it would make readonly members reach *more* apps than public members.

## R2 — Migration vs. none

- **Decision**: Rename stored values on open (user's choice on #97), unlike #8's no-migration choice.
- **Rationale**: The project is pre-release and favors normalizing data over leaving it diverged. Without it, every unpinned deployment's gated apps fall off the ladder at upgrade.
- **Alternatives considered**: No migration with upgrade notes (#8's approach) — rejected by the user.

## R3 — When a pair applies

- **Decision**: Per pair, rename `old → new` iff `!ladder.includes(old) && ladder.includes(new)`, with the ladder resolved off the opening handle (stored `meta.authentikGroupLadder`, overridden by `AUTHENTIK_GROUP_LADDER`, else the default).
- **Rationale**: If the ladder still lists the old name (pinned old ladder), the stored value is valid and renaming it would knock the app off the ladder. If the ladder lacks the successor (a fully custom ladder), the rename would produce another off-ladder value — no gain. Deriving the condition from the effective ladder rather than "is the ladder the default" also covers an operator who pinned the new names explicitly.
- **Note**: The live deployment pins its ladder via `data/authentik.env`; it is untouched until the operator updates or removes that pin, which is the intended behavior.

## R4 — Idempotency and logging

- **Decision**: No marker row. The migration is naturally idempotent (after a rename, no row holds the old name; under a pinned-old ladder the condition is false). It runs every open after a cheap guard (`SELECT 1 ... WHERE auth_group IN (old names) LIMIT 1` across the three tables) and logs one `logInfo` line per table and pair that changed rows, citing `#97`.
- **Rationale**: Matches the #10/#69/#72 migrations' "self-idempotent, log only when something changed" pattern. A one-shot marker would wrongly skip an operator who unpins the old ladder later.
- **Transaction**: one `IMMEDIATE` transaction for all updates, as #72 does, so two processes opening a legacy DB at once don't race.

## R5 — Ordering in `openInventoryDb`

- **Decision**: Run after the `requires_auth → auth_group` loop (#158), at the end of `openInventoryDb`.
- **Rationale**: It writes `auth_group`, so the `ensureColumn(... 'auth_group' ...)` calls must have run. #158 assigns the top rung (`authentik Admins`), which no pair touches, so the order between them does not change outcomes.

## R6 — Where the rename pairs live

- **Decision**: Export `PREVIOUS_DEFAULT_RUNG_RENAMES` (readonly `[old, new]` tuples) from `src/lib/authentik-config.ts`, beside `DEFAULT_GROUP_LADDER`.
- **Rationale**: Ladder names have one definition (Principle II); `inventory.ts` already imports `parseGroupLadder` from there.

## R7 — Out of scope surfaces

- Web permissions/users/groups tables and the `bellhop-admins` admin group are operator-defined Authentik references, not ladder defaults — not touched.
- Historical `specs/0xx-*` documents are records of past defaults and are not rewritten.
- Self-enrollment into `bellhop-public` — follow-up issue.
