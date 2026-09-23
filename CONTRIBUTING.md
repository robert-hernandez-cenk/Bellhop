# Contributing

Thanks for your interest in the Bellhop. This guide covers how
to set up a working copy without any real Proxmox infrastructure, how
changes are made and tested, and the rules a pull request has to meet.

The project constitution, [`.specify/memory/constitution.md`](.specify/memory/constitution.md),
is the authoritative source for project rules. Where this guide and the
constitution disagree, the constitution wins.

## Before you start

Contributions are welcome: bug fixes, features, documentation and tests.

For anything beyond a small, obvious fix, please open an issue first and
describe what you want to change. That settles whether the change fits
before you spend time on it.

This is a single-maintainer project worked on in spare time. Pull requests
are reviewed on a best-effort basis, with no guaranteed timeline.

## Setup

Follow the README's [Prerequisites](README.md#prerequisites) (Node.js 24
or newer) and [Setup](README.md#setup) sections to install dependencies.

Skip the README's first-time inventory step. It writes to the default
inventory path, which is meant for an operator's real hosts. Build a
throwaway inventory from the tracked example file instead:

```bash
INVENTORY_DIR="$(mktemp -d)"
npm run bellhop -- import-yaml-inventory \
  --yaml-path inventory/hosts.yaml.example \
  --db-path "$INVENTORY_DIR/bellhop.db" --apply
export INVENTORY_FILE="$INVENTORY_DIR/bellhop.db"
```

Every command reads the inventory from `INVENTORY_FILE` when it is set, so
the CLI now runs against the example file's hosts and guests. Commands that
would change infrastructure still print a dry run by default (see below),
so you can explore them safely.

`inventory/bellhop.db` is gitignored and must never be committed.

## Making a change

- Work on one branch per issue, in its own git worktree
  (`git worktree add`), so it stays isolated from your other checkouts.
  Where you put the worktree is up to you.
- Changes reach `main` only through a pull request. Fork contributors open
  the pull request from their fork's branch.
- Every command that changes infrastructure or the inventory defaults to a
  dry run that prints exactly what it would do, and acts only when given
  `--apply` (or the equivalent apply action in the web UI or MCP server).
  A new command must follow the same rule, and its preview must match what
  apply actually sends.
- Reuse the existing flag names (`--host`, `--all`, `--group`, `--mid`,
  `--apply`) for the same meaning rather than inventing synonyms.
- The CLI, web UI and MCP server must behave the same for the same action.
  An action exposed in more than one of them is one `Operation` in
  `src/operations/`, not a copy per front end.
- Secrets entered in any front end are masked on input and redacted before
  they reach job history, logs or the jobs database.
- A web UI change must be checked in a browser at desktop width and at a
  mobile width of 640px or narrower. New tables follow the existing
  `data-label` card layout below that breakpoint, and dark-mode styles
  target `:root[data-theme='dark']`.

## Testing

Tests use Node's built-in test runner and live under `test/` as
`*.test.ts`. Run them with `npm test`.

- **Behavior changes ship with tests** in the same change. A bug fix
  includes a test that fails without the fix.
- **No real infrastructure.** Test command logic by injecting a
  `FakeSSHClient` from
  [`test/support/fake-ssh-client.ts`](test/support/fake-ssh-client.ts) as
  the command's `ssh` dependency. Build it with a responder,
  `(sshTarget, sshUser, command) => ExecResult`, then assert on
  `ssh.history` and the function's return value. Never mock `ssh`, `pct`
  or `qm` binaries on `PATH`. Any file under `test/commands/` shows the
  pattern.
- **No real inventory.** An inventory-backed test builds a temporary SQLite
  fixture in a `mkdtempSync` directory and points `INVENTORY_FILE` or the
  command's dependencies at it.
- **Captured fixtures, not invented ones.** A fixture for a third-party API
  (Proxmox, Authentik, Cloudflare, community-scripts) must be captured from
  a real response, then redacted to example values. Redaction keeps the
  response's shape exactly: field names, types, nesting and array lengths.
  A hand-written fixture that only looks plausible is not accepted.
- **Deterministic.** A test must not depend on wall-clock timing, network
  access, test ordering or state left by another test.

A few network clients have no automated test, such as `Ssh2SSHClient`
and the real Authentik client. If you change one, verify it manually
against real infrastructure and say what you verified in the pull request.

## Example data only

Anything committed here can be published, and git history keeps it even
after it is deleted. Every tracked file, including code, tests, fixtures,
docs and commit messages, must use example values only: `pve-node-a` for
a host, `192.0.2.10` for an address, `example.com` for a domain,
`<api-token>` for a credential. Real values of any kind must never be
committed. That includes, for example, hostnames, domains, IP and MAC
addresses, VMIDs of real guests, usernames, emails, tokens, passwords,
SSH keys and VPN credentials. Code must not hardcode one operator's value
as a default either.
The [Example Data Conventions](.specify/memory/constitution.md#example-data-conventions)
table in the constitution lists the allowed ranges and names.

## Pull requests

Before opening a pull request, make sure these pass:

```bash
npm run typecheck
npm test
npm run web:build
```

CI runs the same three checks on Node 24 and Node 26, and all of them must
pass before a pull request merges.

Fill in the pull request template: a summary, the linked issue, and its
checklist. Review your full diff for real operational data before you
submit. A user-visible behavior change updates `README.md` in the same
pull request, and a change to architecture or conventions updates
`CLAUDE.md`.

## Security

Please do not report security vulnerabilities in public issues. See
[`SECURITY.md`](SECURITY.md) for private reporting through GitHub.

## Code of conduct

Everyone taking part in this project is expected to follow the
[code of conduct](CODE_OF_CONDUCT.md).
