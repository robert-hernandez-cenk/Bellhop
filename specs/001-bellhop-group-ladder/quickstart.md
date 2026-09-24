# Quickstart: Validate the Default Group Ladder Rename

All commands run from the repository root of the feature worktree. None touch real infrastructure.

## Prerequisites

- `npm install` has been run in the worktree.
- `AUTHENTIK_GROUP_LADDER` is not set in the shell used for the checks below.

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

Expected: all pass. `test/lib/authentik-config.test.ts` asserts the default ladder is `bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`, `authentik Admins`. The `sync-authentik` tests include an entry stored as `homelab-users` under the default ladder, reported as off-ladder with its Application kept.

## 2. No old default left in the tree

```bash
grep -rn "homelab-app-users\|homelab-users" src web-client/src scripts README.md CLAUDE.md CONTRIBUTING.md
```

Expected: no line presents a `homelab-*` name as the default. The README's upgrade note may name the old ladder as the value to set explicitly.

## 3. Default in effect (User Story 1)

```bash
node --import tsx -e "import('./src/lib/authentik-config.ts').then(m => console.log(m.authentikConfig({}).groupLadder))"
```

Expected: `[ 'bellhop-app-users-open', 'bellhop-app-users', 'bellhop-users', 'authentik Admins' ]`.

## 4. Explicit ladder unchanged (User Story 2)

```bash
node --import tsx -e "import('./src/lib/authentik-config.ts').then(m => console.log(m.authentikConfig({ AUTHENTIK_GROUP_LADDER: 'homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins' }).groupLadder))"
```

Expected: the four `homelab-*`/`authentik Admins` names, in that order.

## 5. Upgrade without configuring the ladder (User Story 3)

Covered by the off-ladder test in step 1, which runs against a temporary inventory and a fake Authentik client. The live equivalent is the operator's dry run below.

## Operator step before deploying

A deployment that relies on the old default must add this line to its `data/authentik.env` before running the new code, or re-tier its gated apps and rename the groups in Authentik:

```
AUTHENTIK_GROUP_LADDER=homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins
```

Then `npm run bellhop -- sync-authentik` (dry run) should report no binding changes and no entries with an unknown `authGroup`.
