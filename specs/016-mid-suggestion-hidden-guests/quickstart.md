# Quickstart: validating MID suggestions for restricted users

## Automated

```bash
npm run typecheck
npm test
npm run web:build
```

Relevant tests: `test/web/routes/provisioning.test.ts` (used-mids route, restricted preview
error), the `checkVmidAvailable` tests, and `test/web-client/mid.test.ts`.

## Manual (browser)

Use a throwaway inventory (never the real one): `INVENTORY_FILE=<temp>/bellhop.db` seeded with
host `pve1` (`midScheme.vmidBase: 4000`) and guests `secret` (vmid 4002) and `media` (vmid 4003),
then run `npm run web:dev`.

1. As admin, on the Permissions page give group `family` an allow-list containing host `pve1`
   and guest `media` only.
2. Impersonate `family`. Open Provisioning → Create VM, pick `pve1`.
   Expected: MID field shows `4` (not `2`).
3. Type `2` in MID and leave the field. Expected: "MID 2 is already in use on pve1." with no
   guest name. Type `3`: the warning names `media`.
4. Install App with MID `2`, Preview (with a fake/unreachable host the remote check fails
   first; with the demo SSH client the VMID-in-use path is exercised by the automated test
   instead). Expected (automated): error contains no `secret`.
5. Stop impersonating. Create VM on `pve1` again: MID shows `4`; typing `2` names `secret`.
6. Repeat steps 2-3 at a ≤640px viewport: the warning wraps inside the field area.
