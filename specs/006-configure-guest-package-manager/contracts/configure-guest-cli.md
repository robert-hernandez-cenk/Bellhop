# Contract: `configure-guest`

Flags are unchanged: `--guest <name>` (required), `--packages <pkgs>`, `--ssh-key <key>`,
`--apply`. The web form and the MCP `configure_guest` tool keep their existing input shape
(`guest`, `packages`, `sshKey`).

## Remote calls, in order

With `--packages`:

1. Probe (`PROBE_COMMAND`) against the target — **in dry run and apply**.
2. Apply only: the detected manager's install command.

With `--ssh-key` (apply only): the idempotent authorized-keys script, unchanged.

A dry run with `--packages` therefore makes exactly one remote call; a dry run with only
`--ssh-key` makes none (unchanged).

## Output (CLI; the web Preview shows the same lines)

```text
[DRY RUN] Would install on media (apk): apk update && apk add 'curl' 'vim'
```

With `--apply`, the same line without `[DRY RUN] `, then the install runs. The SSH-key lines are
unchanged (`[DRY RUN] Would ensure SSH key present on media`).

## Failures (CLI exit 1; web/MCP job fails)

| Case | Error |
| --- | --- |
| Unknown inventory entry | `Unknown inventory entry: <name>` (unchanged) |
| Neither flag | `Specify at least one of --packages or --ssh-key` (unchanged) |
| `--packages` targets a VM | `configure-guest --packages does not install on VMs (<name> is a VM); install packages inside the VM itself` — thrown before any remote call, in dry run and apply; `--ssh-key` given in the same invocation also does not run |
| Unrecognized OS | `UnknownPackageManagerError`: `No known package manager on media (tried apt-get, dnf, apk, pacman, zypper); install the packages on media by hand` |
| Probe exits non-zero | `Package-manager probe failed on media (exit 127): <stderr or "no output">` |
| Install exits non-zero | `Package install failed on media (apk, exit 1): <stderr or "no output">` |
| SSH-key step exits non-zero | `Adding SSH key on media failed (exit 1): <stderr or "no output">` |
| Connection failure | the `runRemote` error, as today |

The first failure stops the run: if `--packages` fails, `--ssh-key` is not attempted. A VM
target's `--packages` rejection happens before any remote call at all, so it counts as the first
failure even ahead of the probe. `--ssh-key` given alone (no `--packages`) is unaffected by a VM
target and still runs.

## `update-all` (companion command, same VM exclusion)

`--group <pve|lxc>` (no longer accepts `vm`); `--host <name>` naming a VM guest rejects with
`update-all does not update VMs (<name> is a VM); update packages inside the VM itself`;
`--group vm` rejects with `update-all does not update VMs; update packages inside the VM
itself`; `--all` silently excludes every VM guest from its target list. The web/MCP `update-all`
operation's `group` field is narrowed to the same two values, and its preview calls the same
`selectUpdateTargets` function apply uses, so preview and apply can never disagree.
