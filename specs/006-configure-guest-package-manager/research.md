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

## R6. Per-call VM wait for package commands (code review, issue #2)

**Decision**: `runRemote` takes an optional fourth argument, `opts?: { vmTimeoutSeconds?: number
}`, used only by the `vm` branch (both the `qm guest exec --timeout <N>` flag and the timeout
failure message); every other branch ignores it. It defaults to the existing 60s
(`VM_EXEC_TIMEOUT_SECONDS`). A new exported constant, `PACKAGE_COMMAND_VM_TIMEOUT_SECONDS = 1800`
(`src/lib/package-manager.ts`), is passed by `update-all`'s update call and
`configure-guest`'s install call — the two places that send a package command to a VM — but not
by `detectPackageManager`'s probe, which keeps the default 60s on every caller.

**Rationale**: once a VM timeout is honestly reported as a failure (FR-010) rather than the old
`parsed.exitcode ?? 0` silent success, a flat 60s wait turns every ordinary `apt-get upgrade`/
`apt-get install` on a VM into a false failure — apt routinely runs past a minute, and a failed
`qm guest exec` leaves the dpkg lock held for whatever attempt runs next. Raising the *global*
60s default instead was rejected: it would make any hung ordinary VM command (a stuck `pct
config` scan, a bad `curl` probe, anything not package-related) block for 30 minutes before
failing, trading one false-failure mode for a much longer hang on unrelated commands. A per-call
option scopes the longer wait to exactly the two call sites that need it.

**Alternatives considered**: a second `runRemoteLongTimeout` function (duplicates the whole `vm`
branch for one differing constant); a `PackageManager`-keyed timeout table (no manager needs a
different wait from another — the packages themselves, not the manager, are what run long).

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
