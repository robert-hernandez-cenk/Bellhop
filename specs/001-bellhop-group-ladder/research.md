# Research: Rename the Default Group Ladder to Bellhop Names

No item in the Technical Context was left as NEEDS CLARIFICATION. The decisions below record what the codebase review settled.

## 1. Where the default lives

- **Decision**: Change the single `DEFAULT_GROUP_LADDER` constant in `src/lib/authentik-config.ts`. Nothing else holds a copy of the default.
- **Rationale**: `authentikConfig()` is the only reader of `AUTHENTIK_GROUP_LADDER`. Every consumer (`sync-authentik`, the `requires_auth` migration in `src/lib/inventory.ts`, `GET /api/auth-groups`, the Dashboard guest-PATCH tier checks, `rungsAtOrAbove`) receives the ladder from it. A search of `src/`, `web-client/src/`, and `scripts/` finds the old names only in that constant.
- **Alternatives considered**: None needed; there is one definition.

## 2. No migration of stored `authGroup` values

- **Decision**: Stored `authGroup` values are not rewritten. Decided by the operator on issue #8.
- **Rationale**: An `authGroup` of `homelab-users` might be a deliberate choice under an explicitly configured ladder, and rewriting it would need Bellhop to guess the operator's intent. The existing off-ladder handling already keeps the failure safe (next item).
- **Alternatives considered**: A one-time rewrite from the old default names to the new ones when `AUTHENTIK_GROUP_LADDER` is unset. Rejected on the issue. It would also rename tiers without renaming the Authentik groups, which would leave every rewritten entry with a missing rung until the operator renamed the groups too.

## 3. Behavior for an operator who upgrades without configuring the ladder

- **Decision**: Rely on existing behavior; add no new code path.
- **Rationale**: Confirmed in `src/commands/networking/sync-authentik.ts`: an entry whose `authGroup` is not on the ladder is split into `offLadder` before any reconciliation. It stays in `desired`, so `toRemove` never deletes its Application, and it is excluded from `actionable`, so its bindings are not touched. `validateInventory` does not reject an off-ladder `authGroup`, so the inventory still loads. The CLI prints "Entries with an unknown authGroup". Access for those apps is unchanged in Authentik until the operator acts, so the failure mode is "stops being maintained", never "access widened".
- **Alternatives considered**: A startup warning in the web service or CLI when stored tiers are off-ladder. Rejected as new surface for a one-time upgrade condition that `sync-authentik` already reports.

## 4. The `requires_auth` legacy migration

- **Decision**: No change.
- **Rationale**: It assigns the ladder's top rung. The top rung is `authentik Admins` in both the old and new default, so a legacy database upgraded after this change lands on the same tier it would have before.

## 5. Tests

- **Decision**: Replace the old default names with the new ones in the eight test files that use them, and add two tests: (a) the default ladder equals the four new names in order; (b) an entry stored as `homelab-users` under the new default is reported as off-ladder by `sync-authentik`, its Application is not deleted, and `loadInventory` still succeeds.
- **Rationale**: Most of the 37 occurrences are fixtures that pick a rung from the default ladder, so they must follow the new default or they become off-ladder and change what the test exercises. The two new tests cover FR-001 and FR-004/FR-005 directly, as Principle III requires for a behavior change.
- **Alternatives considered**: Keeping the old names in fixtures by setting `AUTHENTIK_GROUP_LADDER` in each test. Rejected: it hides the default from the tests that are meant to exercise it and leaks a process-wide env var across tests.

## 6. Documentation

- **Decision**: Update the `AUTHENTIK_GROUP_LADDER` entry in `README.md` with the new default and an upgrade note, and update the two places in `CLAUDE.md` that state the default (the `sync-authentik` bullet and the `requires_auth` migration paragraph, which says the top rung "happens to match" one operator's database). Rewrite the source comment above `DEFAULT_GROUP_LADDER`, which currently says the default "names one deployment's own Authentik groups".
- **Rationale**: FR-007/FR-008, and constitution Principle IV (README for user-visible behavior, CLAUDE.md for conventions). The source comment is the project's record of this single-operator assumption; the workflow rule requires correcting it in the same branch. `CONTRIBUTING.md` does not mention the ladder and needs no change.
- **Alternatives considered**: A separate CHANGELOG. The repository has none; the README's variable entry is where operators look up this default.
