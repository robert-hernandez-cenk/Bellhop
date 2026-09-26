# Data Model: configure-guest package-manager dispatch

No persistent data changes. The inventory schema, `bellhop.db`, and job tables are untouched.
The in-memory shapes below live in `src/lib/package-manager.ts`.

## PackageManager (existing)

`'apt' | 'dnf' | 'apk' | 'pacman' | 'zypper'`. Order of detection is fixed: apt, dnf, apk,
pacman, zypper.

## Command tables

- `UPDATE_COMMANDS: Record<PackageManager, string>` — existing, unchanged.
- `INSTALL_COMMANDS: Record<PackageManager, (packages: string) => string>` — new. The argument
  is the already shell-quoted, space-joined package list; each entry returns a POSIX `sh`
  command (see research R1). Every manager must have an entry (enforced by the `Record` type).

## DetectionResult (new)

| Variant | Fields | Meaning |
| --- | --- | --- |
| `detected` | `pm: PackageManager` | Probe exited 0 and its last line named a supported manager |
| `unknown` | — | Probe exited 0 but reported none of the five (or unrecognized output) |
| `probe-failed` | `result: ExecResult` | Probe itself exited non-zero |

A connection-level failure is not a variant: `runRemote` throws, and callers handle it as they
do today.

## UnknownPackageManagerError (new)

`Error` subclass carrying `target: string`. Thrown by `configure-guest` for the `unknown`
variant; message per research R3.

## Outcome mapping

| DetectionResult | `update-all` | `configure-guest` |
| --- | --- | --- |
| `detected` | run `UPDATE_COMMANDS[pm]` | preview or run `INSTALL_COMMANDS[pm](pkgs)` |
| `unknown` | `failUnknownPm` bucket (unchanged) | throw `UnknownPackageManagerError` |
| `probe-failed` | `failCommand` bucket (unchanged) | throw probe-failure `Error` |
