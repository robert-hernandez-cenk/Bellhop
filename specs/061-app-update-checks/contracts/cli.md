# CLI Contract: check-app-updates

```
bellhop check-app-updates [--guest <name>] [--apply]
```

- Without `--guest`: checks every `lxc` guest that has an `app`, querying guest power status once.
- `--guest <name>`: checks just that guest and skips the status query. Fails, exit 1, with one of:
  - `Unknown inventory entry: <name>`
  - `<name> is not an LXC guest -- check-app-updates only checks LXC guests`
  - `<name> has no community-scripts app recorded -- nothing to check`
- Output: one line per guest, sorted by name:

```
media       jellyseerr  update available  1.2.3 -> 1.3.0   (example-owner/example-app)
web-lxc     homepage    error             GitHub API rate limit reached; the next scheduled check will retry
files-lxc   samba       unsupported       no check_for_gh_release call in ct/samba.sh
db-lxc      postgres    not checked       Guest is stopped
```

- Without `--apply`, the last line is `[DRY RUN] Results not saved -- re-run with --apply to show them on the Update page`. With `--apply`, results are saved: a full run replaces all saved results, and `--guest` replaces that one guest's result.
- Exit code 0 even when individual guests report `error`, since those are results. Exit code 1 only for an argument error or an unexpected failure.
