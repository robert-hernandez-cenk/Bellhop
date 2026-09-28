# Research: configure-guest package-manager dispatch

## R1. Install command per package manager

**Decision**:

| Manager | Install command (`<pkgs>` = shell-quoted names) |
| --- | --- |
| apt | `DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y <pkgs>` (unchanged from today) |
| dnf | `dnf -y install <pkgs>` |
| apk | `apk update && apk add <pkgs>` |
| pacman | `pacman -Syu --needed --noconfirm <pkgs>` |
| zypper | `zypper --non-interactive --gpg-auto-import-keys install <pkgs>` |

**Rationale**: each must refresh metadata enough that a freshly created guest can install,
and must never prompt (the exec channel's stdin is closed).

- apt needs the explicit `update`: container templates ship with empty or stale lists.
- dnf refreshes expired metadata on its own before `install`; `-y` answers the transaction
  prompt.
- apk keeps no index until `apk update` runs; a fresh Alpine container's `apk add` without it
  can fail to find packages. Mirrors the `apk update && apk upgrade` update entry.
- pacman: `-Sy <pkg>` alone is a partial upgrade, which Arch explicitly does not support and
  which can leave the system with mismatched libraries. `-Syu` syncs and upgrades with the
  install, the same reason the update entry is `-Syu`. `--needed` skips packages already
  current.
- zypper refreshes autorefresh-enabled repos on `install`. `--gpg-auto-import-keys` for the
  same reason the update entry carries it: `--non-interactive` alone auto-declines an unknown
  repo signing key.

**Alternatives considered**: `apk add --update-cache` (equivalent, but the two-step form
matches the existing table); `pacman -S` without sync (fails on a stale database with 404s
from the mirror); a separate `zypper refresh` step (redundant with `install`'s autorefresh).

## R2. Where detection lives

**Decision**: add `detectPackageManager(ssh, inventory, target)` to
`src/lib/package-manager.ts`, returning a discriminated result — `{ kind: 'detected', pm }`,
`{ kind: 'unknown' }`, or `{ kind: 'probe-failed', result }`. `runUpdateAll` maps these to its
existing buckets; `runConfigureGuest` throws on the last two.

**Rationale**: the probe-then-parse-then-classify sequence is the part both commands share;
the reaction to each outcome is what differs (bucket vs throw). Returning a result instead of
throwing keeps `update-all`'s per-target loop simple. Connection errors still throw from
`runRemote`, which `update-all` already catches as `failConnect`.

**Alternatives considered**: keep the probe inline in both commands (duplicated logic,
against Principle II); a throwing helper (would force `update-all` to catch and re-classify
three error types).

## R3. How an unrecognized OS is reported

**Decision**: an exported `UnknownPackageManagerError` class; `configure-guest` throws it. Its
message: `No known package manager on <target> (tried apt-get, dnf, apk, pacman, zypper);
install the packages on <target> by hand`. The tried-list string is exported once and also
used by `update-all`'s existing warning, whose text does not change.

**Rationale**: a class lets any caller (web, MCP, tests) tell this case apart with
`instanceof`, which is what "distinct from a generic failure" needs for a single-target
command. The message says what to do next (Principle IV).

## R4. Dry run probes the guest

**Decision** (operator's choice during design): the dry run runs the probe, then prints
`[DRY RUN] Would install on <target> (<pm>): <exact command>`; `--apply` prints the same line
without the prefix and runs it. Probe failures and unknown OS fail the dry run the same way
they fail apply.

**Rationale**: matches `create-lxc`/`install-app`, whose previews already make a live SSH
call so the previewed command is provably what apply sends (CLAUDE.md "Dry-run convention").
The web Preview already runs `runConfigureGuest` with the real SSH client in `deps`, so no
operation change is needed.

## R5. Exit-code handling

**Decision**: check `code !== 0` on the install result and on the `--ssh-key` result, and throw
an `Error` naming the target, the manager (for install), the exit status, and trimmed stderr
(or `no output`). Commands run in order and the first failure stops the run.

**Rationale**: today both results are discarded, so failures report success. The CLI's
`action()` wrapper already turns a thrown error into a logged message and exit code 1, and a
thrown `apply()` already fails the web/MCP job, so throwing is the whole integration.

## R6. VMs are excluded from package update/install entirely (operator PR review, issue #2)

**Decision**: neither `update-all` nor `configure-guest --packages` ever sends a package command
to a VM. `selectUpdateTargets` (`src/commands/maintenance/update-all.ts`) is the one place
`update-all`'s targets are decided: `{ all: true }` silently drops every `vm` guest from the
result (hosts and lxc guests only); `{ group: 'vm' }` and `{ host: <vm-name> }` are explicit
requests to target a VM, so both reject outright with a named error rather than silently
resolving to nothing. `configure-guest --packages` on a guest of type `vm` throws before any
remote call, in both dry run and apply — `--ssh-key` alone still works against a VM, since that
step is unrelated to package management. Both `runUpdateAll` and `runConfigureGuest` call this
check before doing anything else, so the operations-layer preview (which must equal apply) sees
the same rejection/exclusion the CLI does.

This replaces the previous decision (a per-call `vmTimeoutSeconds` override on `runRemote`,
defaulting to 60s and raised to `PACKAGE_COMMAND_VM_TIMEOUT_SECONDS = 1800` for a package
command) — `runRemote`'s optional fourth argument and the exported timeout constant are both
removed, since no caller sends a package command to a VM anymore. `runRemote`'s `vm` branch
keeps its existing, non-package-specific handling of `VM_EXEC_TIMEOUT_SECONDS` (60s, unconfigurable
per call), its timeout-envelope failure reporting, and its signal-killed-command failure
reporting (R7 below) — those apply to every command still routed to a VM through `runRemote`
(e.g. `guest-power`, `set-guest-vpn`), just no longer to a package command.

**Rationale**: the operator reviewing PR #23 asked that the package update/install mechanism
never act on VMs at all, rather than working around the fact that a VM's package manager
routinely outlasts a reasonable `qm guest exec` wait. Excluding VMs outright is simpler than
tuning a timeout for them: there is no wait long enough to be both safe for a hung, unrelated VM
command and comfortable for a full `apt-get upgrade`, and a VM's own packages are better updated
from inside the VM itself (e.g. via a scheduled task, or interactively), which this toolkit does
not model.

**Alternatives considered**: keeping the per-call timeout override (rejected — it does not
address the operator's actual objection, which is that this toolkit should not be in the business
of blindly running package commands inside a VM at all); silently excluding a `--host`/`--group
vm` selector too instead of rejecting it (rejected — an operator naming a VM explicitly has made
a mistake worth surfacing, unlike `--all`, which is a request for "everything safe to update").

## R7. Signal-killed VM command (code review, issue #2)

**Decision**: `qm guest exec`'s JSON envelope for a process killed by a signal is `{"exited":1,
"signal":<N>, "out-data":..., "err-data":...}` — no `exitcode` at all, the same as the pid-only
"still running" timeout envelope, but carrying a `signal` number and real output instead of a
`pid`. `runRemote`'s `vm` branch now checks for `typeof parsed.signal === 'number'` before
falling through to the timeout case, and reports it as `code: 1`, `stdout:
parsed['out-data'] ?? ''`, `stderr`: the trimmed `err-data` followed by `killed by signal <N>`
(or just `killed by signal <N>` when `err-data` is empty).

**Rationale**: before this fix, the same `typeof parsed.exitcode !== 'number'` check that
correctly catches the pid-only timeout envelope also caught this shape, misreporting a
signal-killed command as "still running" and discarding whatever output it had already produced
— actively worse than the timeout message, which is at least honest about failing, since it also
threw away real diagnostic output. Verified live 2026-09-26: `qm guest exec <vmid> --timeout 10
-- sh -c 'echo before; echo oops >&2; kill -9 $$'` returns exactly this shape.
