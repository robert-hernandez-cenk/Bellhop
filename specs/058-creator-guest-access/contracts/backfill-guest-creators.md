# Contract: `backfill-guest-creators` (CLI only)

```
bellhop backfill-guest-creators [--map <old=new>]... [--apply]
```

- **Dry run by default.** Prints the plan and changes nothing; `--apply` writes
  the inventory once with every planned update.
- `--map old=new` (repeatable): treat job rows recorded under login name `old`
  as login name `new` before resolving against the identity provider. A
  malformed pair (no `=`, empty side) is an error naming the flag.
- Requires `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN` (`data/authentik.env`);
  without them it fails with the existing "not configured" message.

## Selection

A job row is a candidate when `command` is one of `create-lxc`, `create-vm`,
`install-app`, `deploy-vpn-gateway`, `status` is `success`, and
`triggered_by_username` is non-null, not `mcp`, and not the local operator's
username (`WEB_UI_LOCAL_USER`, default `local`) -- neither is a real person.

Guest name: `hostname` (create-lxc, install-app) or `name` (create-vm,
deploy-vpn-gateway) from `args_json`; host: `host`; VMID: `resolveMid(inventory,
host, Number(mid)).vmid`.

Each recorded creator is `{ uid?, username, since }`, `since` being the
creating job's `startedAt`: the creator's job lift then covers that job and
later ones only.

## Output (dry run, example values)

```
Would record creators for 2 guest(s):
  + web-lxc (pve1, vmid 4004): test-user  [job 12]
  + demo-vm (pve2, vmid 5007): admin  [job 31]
Skipped 3 job(s):
  - job 7 install-app: unknown-user (old-login; pass --map old-login=<current username>)
  - job 9 create-lxc: no-matching-guest (media on pve1, vmid 4009)
  - job 15 install-app: already-has-creator (web-lxc)
Dry run -- re-run with --apply to write these.
```

With `--apply`, the first line reads `Recorded creators for N guest(s):` and the
trailer is omitted. `--apply` re-checks each update against the inventory as
reloaded just before writing; one whose guest has gained a creator or left the
inventory meanwhile is not written and is listed under the skips
(`already-has-creator` or `no-matching-guest`) instead. Exit code 0 either way; skips are informational.
