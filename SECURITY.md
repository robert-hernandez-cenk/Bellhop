# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub, using
**Security → Report a vulnerability** on this repository. That opens an
advisory thread visible only to you and the maintainer.

Please do **not** open a public issue for a suspected vulnerability.

There is no email reporting address — GitHub's private reporting is the
only channel, deliberately, so there is no published inbox to monitor.

A useful report says what an attacker can do, how to reproduce it, and
which part of the toolkit is involved: the CLI, the web UI, or the
remote-execution layer.

## Supported versions

Only `main` is supported.

This project publishes no releases, tags, or version branches, so there
is no version matrix and nothing to backport to. Fixes land on `main`,
and adopters are expected to track it.

## What is in scope

- **Web UI authorization.** Anything that lets a signed-in user view or
  act on a host or guest an administrator has restricted them from, or
  that lets an unauthenticated request reach the `/api` routes.
- **Credential handling.** This toolkit reads SSH private keys from the
  operator's `~/.ssh/`, provisions public keys into newly created guests
  via `authorized_keys`, and holds an Authentik API token and VPN
  provider credentials. Leaking, logging, or misusing any of these is in
  scope.
- **Command injection** into the remote-execution path — anywhere
  inventory data or user input reaches a command run on a remote host.

## What is out of scope

These are deliberate design choices rather than oversights, and reports
about them will be closed as working as intended.

- **A hostile inventory database.** The CLI assumes a single trusted
  operator who authored their own inventory, so an inventory file
  hand-edited by that operator is not treated as untrusted input —
  anyone able to edit it directly can already run commands as the
  operator. That exemption covers direct edits only. Values written into
  the inventory *through the web UI* by a non-administrator are covered
  by the authorization and command-injection items above, and are in
  scope.
- **The inventory database being unencrypted at rest.** It holds
  hostnames and addresses, not credentials, and relies on the file
  permissions of the machine it lives on.
- **Anything requiring existing shell access** to a Proxmox host or to
  the operator's own workstation. At that point an attacker already has
  everything the toolkit could give them.

## Deployment prerequisites

The web UI's security model depends on all of the following being true.
Break any one of them and the web UI is effectively unauthenticated.
That is a deployment error rather than a flaw in the code, but the
consequences are the same — so please check these before reporting.

- **The web UI has no login of its own.** It must sit behind a Caddy
  `forward_auth` directive pointing at an Authentik instance. Exposed
  directly, it authenticates nobody.
- **It trusts the `X-authentik-*` request headers unconditionally.** That
  is only safe if the app's port is reachable from Caddy's address alone.
  The Windows service installer enforces this with a firewall rule scoped
  to that address; any other deployment must arrange the equivalent
  itself. Wherever the port is reachable more widely, anything on that
  network can set those headers itself and become any user,
  administrators included.
- **`WEB_UI_DEV_USER` and `WEB_UI_DEV_GROUPS` must never be set in
  production.** They exist so local development and the test suite can
  run without Caddy in front. Wherever they are set, a request carrying
  no identity headers becomes an authenticated user in whatever groups
  they name — administrator groups included.

## Response expectations

This is a single-maintainer project worked on in spare time. Reports are
acknowledged and investigated as soon as I am able, on a best-effort
basis. There is no guaranteed response or fix timeline.
