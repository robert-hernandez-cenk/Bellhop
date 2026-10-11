# Quickstart: Validate the Audience-Named Default Ladder

Run from the worktree root.

## 1. Automated checks

```bash
npm run typecheck
npm test
```

Expected: all pass. `test/lib/authentik-config.test.ts` asserts the five-rung default; `test/lib/inventory.test.ts` covers each migration condition in [contracts/configuration.md](contracts/configuration.md).

## 2. Default ladder

```bash
AUTHENTIK_GROUP_LADDER= node -e "import('./src/lib/authentik-config.ts').then(m => console.log(m.parseGroupLadder(undefined)))"
```

Expected: `[ 'bellhop-public-readonly', 'bellhop-public', 'bellhop-friends-family', 'bellhop-admin-family', 'authentik Admins' ]`.

## 3. Migration against a fixture

Build a temp inventory from `inventory/hosts.yaml.example` with a guest at `authGroup: bellhop-users`, then load it with no ladder configured:

```bash
AUTHENTIK_GROUP_LADDER= node -e "import('./src/lib/inventory.ts').then(m => console.log(m.loadInventory('<tmp>/bellhop.db').guests.map(g => g.authGroup)))"
```

Expected: one `Renamed 1 row(s) in 'guests' from auth_group='bellhop-users' to 'bellhop-admin-family' (#97 ...)` line on the first run, none on the second. With `AUTHENTIK_GROUP_LADDER=bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins`, nothing is renamed.

## 4. Web UI

`npm run demo`, open the Settings page's Authentik tab: the group-ladder placeholder and help show the new default. Open a gated guest's Advanced modal: the tier dropdown lists the five tiers. Check at desktop width and ≤640px.
