# Bellhop Constitution

## Core Principles

### I. No Real Operational Data in the Repository (NON-NEGOTIABLE)

This repository is headed for public release. Anything committed to it can be published, and
git history keeps it after a later commit deletes it.

- Every tracked file MUST use example values only: source, tests, fixtures, README, docs,
  Spec Kit specs, plans, task lists, checklists, and commit messages. Example values follow
  the Example Data Conventions section below.
- Real hostnames, domain names, IP addresses, MAC addresses, VMIDs tied to real guests,
  usernames, email addresses, API tokens, passwords, SSH keys, and VPN credentials MUST NOT
  be committed.
- Real values MUST live only in gitignored locations: `inventory/bellhop.db`,
  `data/*.env`, or a private companion repository kept outside this one.
- A test fixture captured from a live system MUST be redacted to example values before it is
  committed. Redaction MUST preserve the response's shape exactly: field names, types,
  nesting, and array lengths. Only identifying values change.
- Code MUST NOT hardcode an operator-specific value as a default. A value that differs
  between deployments MUST be read from the inventory settings, an environment variable, or
  a flag. When the value is missing, the code MUST fail with an error that names how to set
  it. It MUST NOT fall back to one operator's value.
- A real value found in a tracked file is a defect. It MUST be removed from the current tree
  in its own change, and that change MUST say whether history needs rewriting.

**Rationale**: once the repository is public, one leaked token or real address cannot be
recalled. Keeping example values out of the code also makes the toolkit usable by other
operators, which is the point of publishing it.

### II. Code Quality

- TypeScript MUST compile under the repository's `strict` configuration with no errors.
  `npm run typecheck` is the check. Suppressions (`@ts-ignore`, `@ts-expect-error`, a
  non-null `!` that hides a real gap, `any`) MUST carry a comment saying why they are safe.
- Remote execution MUST go through `src/lib/`. `Ssh2SSHClient` is the only code that opens an
  SSH connection, and `runRemote` is the only function that executes something remote. A
  command MUST NOT call `ssh2`, spawn `ssh`, or build its own transport.
- A command sent to an LXC or VM guest through `runRemote` MUST be POSIX `sh`. Bash-only
  syntax is allowed only in the documented exceptions, and a new exception MUST be recorded
  in `CLAUDE.md` with the reason.
- Data crossing a trust or process boundary MUST be validated with `zod`: inventory rows,
  web and MCP request bodies, and third-party API responses. Rules that span several entries
  belong in `validateInventory()`, not scattered across commands.
- Errors MUST be explicit. A silent fallback that would surface much later as an unrelated
  failure is not allowed. An error message MUST name what failed and how to fix it.
- New code MUST match the surrounding code's naming, structure, and comment density. Shared
  logic MUST live in one place: `src/lib/` for infrastructure helpers, `src/operations/` for
  actions reachable from the web UI or MCP server. It MUST NOT be copied between call sites.
- Simplicity wins over speculative hardening. For the CLI and the inventory, the operator is
  trusted, and validation exists to catch typos and misconfiguration. The web UI is the
  exception: authorization for a less-trusted co-user MUST be enforced as rigorously as any
  other correctness requirement.

**Rationale**: a single remote-execution boundary and schema-validated inputs keep the
dangerous parts of the toolkit small enough to review. Explicit errors are what let an
operator who is not the original author diagnose a failure.

### III. Testing Standards

- Every behavior change MUST ship with automated tests in the same change. A bug fix MUST
  include a test that fails without the fix.
- Tests MUST use Node's built-in test runner and live under `test/` as `*.test.ts`.
- Command logic MUST be tested by injecting a `FakeSSHClient` as the `ssh` dependency and
  asserting on its `history` and the function's return value. Tests MUST NOT mock `ssh`,
  `pct`, or `qm` binaries on `PATH`.
- Tests MUST NOT touch real infrastructure or the real inventory. Inventory-backed tests MUST
  build a temporary SQLite fixture in a `mkdtempSync` directory and point `INVENTORY_FILE` or
  the command's dependencies at it.
- A fixture for a third-party API (Proxmox, Authentik, Cloudflare, community-scripts) MUST be
  captured from a real response and redacted per Principle I. A hand-authored fixture that
  merely looks plausible is not acceptable.
- `Ssh2SSHClient` and the other real network clients with no automated test MUST be verified
  manually against real infrastructure whenever they change, and the change's description
  MUST record what was verified.
- `npm run typecheck`, `npm test`, and `npm run web:build` MUST all pass on every supported
  Node version in CI before a change merges to `main`.
- A test MUST be deterministic. It MUST NOT depend on wall-clock timing, network access, test
  ordering, or state left behind by another test.

**Rationale**: the toolkit's commands create and destroy real guests. The fake SSH client
and temporary inventory let that logic be exercised thoroughly without risking any real host.
Captured fixtures catch mismatches with real APIs that invented fixtures hide.

### IV. User Experience Consistency

- Every command that changes infrastructure or the inventory MUST default to a dry run that
  prints exactly what it would do. It MUST act only when given `--apply`, or the equivalent
  apply action in the web UI or MCP server. The preview MUST match what apply sends.
- The CLI, web UI, and MCP server MUST behave the same for the same action. An action exposed
  in more than one front end MUST be one `Operation` in `src/operations/`, and a value
  rejected by one front end MUST be rejected with the same rule by the others.
- Flag names, option spellings, and targeting conventions (`--host`, `--all`, `--group`,
  `--mid`, `--apply`) MUST be reused for the same meaning across commands. A new command MUST
  NOT invent a synonym for an existing flag.
- Error and warning messages MUST tell the user what to do next, such as the `set-config`
  key, flag, or form field that fixes the problem.
- Secrets entered in any front end MUST be masked on input and redacted before they are
  written to job history, logs, or the jobs database.
- A web UI change MUST be verified in a browser at a desktop-width viewport and at a mobile
  viewport of 640px or narrower before it is reported complete. Tables MUST follow the
  `data-label` card-layout convention below the breakpoint, and themed styles MUST target
  `:root[data-theme='dark']`.
- A user-visible behavior change MUST update `README.md` in the same change. A change to
  architecture or conventions MUST update `CLAUDE.md` in the same change.

**Rationale**: an operator who learns one command should be able to predict the rest. A dry
run that matches the real apply is the toolkit's main safety mechanism, and it only works if
every front end honors it.

## Example Data Conventions

These values apply to every tracked file under Principle I. Pick values that are obviously
fake to a reader.

| Kind | Use | Source |
| --- | --- | --- |
| Domain names | `example.com`, `example.net`, `example.org`, or names under `.example`, `.test`, `.invalid` | RFC 2606, RFC 6761 |
| IPv4 addresses | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | RFC 5737 |
| IPv6 addresses | `2001:db8::/32` | RFC 3849 |
| MAC addresses | `00:00:5E:00:53:00` through `00:00:5E:00:53:FF` | RFC 7042 |
| Proxmox hosts | Generic names such as `pve1`, `pve2`, `pve-node-a` | — |
| Guests and apps | Generic names such as `media`, `web-lxc`, `demo-vm` | — |
| Email and users | `user@example.com`, `admin`, `test-user` | — |
| Tokens, passwords, keys | Obvious placeholders such as `<api-token>`, `example-token`, `changeme` | — |

- A private RFC 1918 address MAY be used only when the example must show private-LAN
  behavior, such as a `midScheme` IP prefix. It MUST NOT be copied from real infrastructure.
- An SSH public key in a fixture MUST be generated for the fixture, or be a clearly truncated
  placeholder. It MUST NOT be a key that is trusted anywhere.
- Example values MUST be consistent within one document, so a reader can follow the same
  example host from one section to the next.

## Development Workflow and Quality Gates

- Work on an issue MUST happen on its own branch in a git worktree, and MUST reach `main`
  through a pull request. `main` MUST NOT receive a local merge or a direct commit.
- A pull request MUST pass the CI gates in Principle III before merging.
- Before a pull request is opened or updated, its full diff MUST be reviewed for real
  operational data per Principle I. This includes new fixtures, spec and plan files, and
  commit messages.
- Spec Kit specifications, plans, and task lists committed to this repository are public
  artifacts and MUST follow Principle I. A design note that needs real values MUST NOT be
  committed here; it belongs outside this repository.
- When a branch introduces, fixes, or changes an assumption that only holds for one
  operator's deployment, that assumption MUST be recorded or corrected in the same branch,
  wherever the project keeps its record of them.
- A change to real infrastructure MUST happen first. The inventory and documentation are
  updated to match only after the real change is confirmed.

## Governance

This constitution takes precedence over other project practice. When a specification, plan,
task list, or runtime guidance file (`CLAUDE.md`, `README.md`) conflicts with it, the
constitution wins, and the conflicting document MUST be corrected.

- **Amendments**: an amendment MUST be made through a pull request that edits this file and
  states what changed and why. If an amendment makes existing code non-compliant, the pull
  request MUST either include the fix or open an issue that tracks it.
- **Versioning**: the version follows semantic versioning. MAJOR is for removing a principle
  or redefining one incompatibly. MINOR is for adding a principle or section, or materially
  expanding guidance. PATCH is for clarifications and wording fixes that do not change what
  is required.
- **Compliance review**: `/speckit-plan` MUST evaluate its Constitution Check against these
  principles before design begins, and again after. Each pull request review MUST confirm
  compliance with Principles I through IV. A justified deviation MUST be recorded in the
  plan's Complexity Tracking table, with the simpler compliant alternative and why it was
  rejected.
- **Runtime guidance**: `CLAUDE.md` holds day-to-day development guidance and MUST stay
  consistent with this constitution.

**Version**: 1.1.0 | **Ratified**: 2026-09-17 | **Last Amended**: 2026-09-23
