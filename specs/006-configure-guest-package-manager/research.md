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
