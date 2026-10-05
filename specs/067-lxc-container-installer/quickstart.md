# Quickstart: validating the LXC container feature

## Bellhop side (automated, run in this worktree)

```bash
npm run typecheck
npm test
npm run web:build
```

The tests that matter (new or changed):

- `test/lib/bellhop-guest.test.ts`: `isBellhopGuest`/`assertNotBellhopGuest` with the setting unset, set to a guest, and set to an unknown name.
- `test/commands/update-app.test.ts`, `delete-guest.test.ts`, `migrate-guest.test.ts`, `guest-power.test.ts`: refusal for the own guest in dry run and apply, with `FakeSSHClient.history` empty; other guests unaffected.
- `test/commands/update-all.test.ts`: own guest in `skippedSelf`, others processed; `--host <self>` alone returns no failures.
- `test/operations/...` or the web route tests: the `delete-guest` operation refuses before Authentik teardown; the `update-all` preview names the skipped guest.
- `test/commands/set-config.test.ts`: `bellhopGuest` round-trips.
- `test/bin/bellhop-shim.test.ts` (or similar): the shim runs `--help` from a directory outside the repo.

Manual checks:

1. From a temp directory: `node <worktree>/bin/bellhop.js --help` prints the help (it failed with `ERR_MODULE_NOT_FOUND` before the fix).
2. With a fixture inventory (`INVENTORY_FILE=<tmp>/bellhop.db`): `bellhop set-config bellhopGuest web-lxc --apply`, then `bellhop guest-power --guest web-lxc --state shutdown` prints the refusal.
3. The Settings page (`npm run demo`) shows "Bellhop's own guest" on the General tab, at a desktop width and at a 390px-wide mobile viewport.
4. `npm run service:install` is not run (it would install a real service); read the notice in the code path instead, or run `tsx scripts/windows-service.ts` with no argument to see the notice followed by the usage line.

## Fork side

```bash
bash -n ct/bellhop.sh
bash -n install/bellhop-install.sh
shellcheck ct/bellhop.sh install/bellhop-install.sh   # if installed
node -e "JSON.parse(require('fs').readFileSync('json/bellhop.json','utf8'))"
```

## Live (operator, after merge and a first release)

1. Cut the first GitHub release of Bellhop.
2. On a Proxmox host: run `ct/bellhop.sh` from the fork's `local` branch (or Install App in Bellhop with the custom script source).
3. Open `http://<container-ip>:3000`, and follow `docs/lxc-container.md` through to `sync-inventory`.
4. Run the update in the container; confirm that "no update" is reported, and that after a newer release the data is unchanged.
