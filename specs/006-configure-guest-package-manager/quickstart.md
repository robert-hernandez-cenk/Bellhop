# Quickstart: validating configure-guest package-manager dispatch

## Automated (no infrastructure)

```bash
npm run typecheck
npm test
```

Expected: all tests pass, including the new `configure-guest` and `package-manager` cases and
the unchanged `update-all` suite. They cover, with a `FakeSSHClient`:

- each of the five managers gets its own install command, package names quoted
  ([data model](data-model.md), [research R1](research.md))
- dry run makes exactly one remote call (the probe) and prints the exact command
- unknown OS, probe failure, install failure, and SSH-key failure each reject with the message
  in [the contract](contracts/configure-guest-cli.md)

## Manual (real guest, optional)

Against a running Debian guest `media` and, if available, a running Alpine guest:

```bash
bellhop configure-guest --guest media --packages "curl"            # dry run: shows (apt) command
bellhop configure-guest --guest media --packages "curl" --apply    # installs, exit 0
bellhop configure-guest --guest media --packages "no-such-pkg-x" --apply   # exit 1, apt error shown
bellhop configure-guest --guest <alpine-guest> --packages "curl"   # dry run: shows (apk) command
```

Expected: the dry-run command matches what `--apply` logs; a bad package name exits 1 with
the remote error instead of reporting success.
