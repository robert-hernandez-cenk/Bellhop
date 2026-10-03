# Research: Proxmox Access for VM Creators

All findings below were checked against a live Proxmox VE 9.2.10 cluster on
2026-10-03 using read-only commands only. Captured responses are committed
under `test/fixtures/proxmox/`, redacted to example values per the
constitution's Principle I, with their shape unchanged.

## R1 — How a realm names its users

**Decision**: Read the realm with
`pvesh get /access/domains/<realm> --output-format json` and use only its
`type` and `username-claim`. `openid` + `username` → `<username>@<realm>`;
`openid` + `email` → `<email>@<realm>`; anything else → no grant.

**Live shape**: an OpenID realm returns
`{"autocreate":1,"client-id":…,"client-key":…,"comment":…,"digest":…,"issuer-url":…,"scopes":"openid profile email","type":"openid","username-claim":"email"}`.
A `pve` realm returns no `username-claim` at all. A realm that doesn't exist
fails with `domain '<realm>' does not exist` on stderr and a non-zero exit.
The live deployment's realm uses the **email** claim, so the email path is
the main one in practice, not an edge case.

**Rationale**: The realm's own configuration is the single source of truth
for how Proxmox will name the person, so reading it avoids a second setting
that could disagree with it.

**Alternatives considered**: A `pveUserClaim` setting (rejected: it
duplicates the realm's config and drifts silently). Supporting `subject`
via the `X-authentik-uid` header (rejected: the subject Proxmox sees comes
from *Proxmox's own* OIDC provider's subject mode, which Bellhop can't
know).

## R2 — The realm read must not leak the OIDC client secret

**Finding**: The realm response carries `client-key`, the OIDC client
secret, in clear text. Every `exec` made inside a web or MCP job streams its
stdout into the job log (`JobSSHClient.exec` passes `onChunk` through), so
a plain `pvesh get` would write the secret into job history.

**Decision**: Filter on the host and print only the two fields:

```sh
set -o pipefail; pvesh get /access/domains/<realm> --output-format json | perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print encode_json({ type => $d->{type}, "username-claim" => $d->{"username-claim"} }), "\n"'
```

Verified live: it prints `{"type":"openid","username-claim":"email"}` for
the OpenID realm and `{"type":"pve","username-claim":null}` for `pve`. For a
missing realm, stderr carries Proxmox's own message and the exit status is
non-zero. `JSON::PP` is a core Perl module and Perl ships with every Proxmox
host. The command targets a `pve` host, so it runs in the host's bash login
shell (`pipefail` is available), not through the guest `sh -c` wrapper.

**Alternatives considered**: Parsing `/etc/pve/domains.cfg` with awk (rejected:
it duplicates Proxmox's own parsing and defaults, and `client-key` sits in
the same file). Reading the realm and filtering in Node (rejected: the
secret would already be in the log by then).

## R3 — Pre-creating a user, and ACLs

**Decision**:

```sh
pvesh get /access/users/<userid> >/dev/null 2>&1 || pveum user add <userid> --comment 'Created by Bellhop for VM <vmid>'
pveum acl modify /vms/<vmid> --users <userid> --roles <role>
```

**Live shape**: a missing user fails with `no such user ('<userid>')` and a
non-zero exit. The cluster's existing hand-made grants have exactly the
shape this feature produces: `{"path":"/vms/<vmid>","propagate":1,"roleid":"PVEVMAdmin","type":"user","ugid":"<email>@<realm>"}`.
That confirms both the email form of the user ID (`user@example.com@realm`)
and `PVEVMAdmin` as the role operators already choose. `pveum acl modify`
propagates by default (`propagate: 1`).

**Rationale**: OpenID realms with `autocreate` only create the user on first
login. Creating it ahead of time is what lets a first-time Proxmox user see
their VM immediately. A later OIDC login maps onto the existing user ID.

## R4 — Destroy already removes per-guest ACLs (User Story 5)

**Finding**: In the live host's `PVE/API2/Qemu.pm` (line 2868) and
`PVE/API2/LXC.pm` (line 912), `PVE::AccessControl::remove_vm_access($vmid)`
is called on every destroy, *outside* the `if ($param->{purge})` branch.
`remove_vm_access` (`PVE/AccessControl.pm`) deletes the whole
`acl_root → vms → <vmid>` subtree and the VMID's pool membership.

**Decision**: No cleanup step is added to `delete-guest` or `migrate-guest`.
A reused VMID can't inherit an old guest's permissions, because Proxmox
removes them on destroy, with or without `--purge`. FR-015 is satisfied with
no code change. This finding is the recorded verification.

**Consequence for migration**: the same call also removes the old VMID's
*pool* membership. Copying pool membership is out of scope (no pool is used
in this feature). It's recorded as a known limitation in
`docs/proxmox-access.md`.

## R5 — Reading ACLs for a migration without dumping the whole cluster's

**Finding**: `pvesh get /access/acl --output-format json` returns every
permission in the cluster, including other people's user IDs (emails). In a
job, that whole list would land in the log.

**Decision**: Filter on the host to entries whose `path` is exactly
`/vms/<old>`, again with `JSON::PP`:

```sh
set -o pipefail; pvesh get /access/acl --output-format json | perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print encode_json([grep { $_->{path} eq "/vms/<old>" } @$d]), "\n"'
```

Each entry is `{path, propagate (0|1), roleid, type (user|group|token), ugid}`.
It's re-created with `pveum acl modify /vms/<new> --users|--groups|--tokens <ugid> --roles <roleid> --propagate <0|1>`.
Node still validates the parsed result with zod, and filters again, so a
misbehaving filter can't widen the copy.

## R6 — Getting the actor to the job

**Finding**: `previewAndEnqueue`'s `enqueue` already runs `op.apply(input, { ...deps, ssh: jobSsh })`.
So whatever is on the `deps` the web route passes reaches `apply()`. The
standalone preview route also calls `op.preview(..., deps())`. The triggering
user is computed only as `Attribution` (username only, for the job row) by
`resolveTriggeredBy(req)` in `src/web/impersonation.ts`.

**Decision**: Add an optional `actor?: { username: string; email?: string }`
to `OperationDeps`. Add `resolveActor(req)` next to `resolveTriggeredBy`, using
the same real-user rule (`req.realUser ?? req.user`). It returns `undefined`
for the synthetic local operator (`localOperator: true`). The provisioning
router's `deps()` takes the request and sets `actor`. `core.ts` is unchanged,
and the MCP server passes no actor.

**Alternatives considered**: An internal `actor` input field, like
`appSource` (rejected: identity isn't operation input, and it would need care
to stay out of `argsJson` and the MCP schema). A post-job hook in the route
(rejected: it's a second code path outside the job, and its output would
miss the job log).

## R7 — Where the grant runs relative to inventory recording

**Decision**: `create-vm`'s `apply()` runs the grant in a `finally` around
`recordProvisionedGuest`. Once `runCreateVm` has succeeded the VM exists, so
the grant is attempted even if a later step (an inventory write or a
`syncProxyLive` push for subdomains) fails the job. `grantCreatorAccess`
never throws, so it can't mask that step's error. If `runCreateVm` itself
throws, there's no VM and nothing to grant.

## R8 — Settings validation

**Decision**: `pveUserRealm` must match `^[A-Za-z][A-Za-z0-9._-]+$`, matching
Proxmox's own `pve-realm` format. `pveCreatorRole` must match
`^[A-Za-z0-9._-]+$`, matching Proxmox's role-ID characters. Both are optional
`meta` settings added to `SettingsSchema`, so `set-config` and the Settings
page share them automatically. The Settings page is a flat field list with no
groups, so the two fields are appended to it as always-visible entries (the
spec's "Proxmox access" group became two adjacent fields).

**User ID safety**: the user part of a Proxmox user ID can't contain
whitespace, `:` or `/`. A username or email that does is skipped with a
warning rather than sent, and every value is `shellQuote`d.

## R9 — Front-end consistency (constitution IV)

The rule is the same in every front end: grant to the signed-in creator,
when there is one. Only the web UI has a signed-in person. MCP and CLI run
with operator-level trust and no per-person identity, so they never grant.
The MCP preview and job say so in one line when the realm is configured. This
is one rule applied to different inputs, not a divergence.
