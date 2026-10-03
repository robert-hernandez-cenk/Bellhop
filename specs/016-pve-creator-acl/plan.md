# Implementation Plan: Proxmox Access for VM Creators

**Branch**: `issue-53-pve-creator-acl` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/016-pve-creator-acl/spec.md`

## Summary

A VM created from the web UI is granted to its creator in Proxmox. A new
`src/lib/pve-acl.ts` reads the configured OpenID realm's username claim on the
VM's host (filtered there, so the realm's client secret never reaches the
job log), derives the creator's Proxmox user ID, creates that user if
missing, and runs `pveum acl modify /vms/<vmid>` with a configurable role
(default `PVEVMAdmin`). The step never fails the job. The real signed-in user
reaches `apply()` as an optional `actor` on `OperationDeps`, which only the
web provisioning router sets. `migrate-guest` copies every `/vms/<old>`
permission to the new VMID before destroying the original. A live check of
Proxmox 9.2.10's source showed that destroy already removes a VMID's
permissions (research R4), so deletion needs no change.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22+ (as CI)

**Primary Dependencies**: existing only: `zod`, `better-sqlite3`, `ssh2` (via `runRemote`), React for the Settings page

**Storage**: two new optional keys in the existing `meta` table; no schema change

**Testing**: Node's built-in runner, `FakeSSHClient`, temp SQLite fixtures, captured+redacted fixtures under `test/fixtures/proxmox/`

**Target Platform**: Proxmox VE 9.x hosts (verified on 9.2.10); `perl` + core `JSON::PP` on the host

**Project Type**: CLI + web service + MCP server sharing `src/operations/`

**Performance Goals**: at most three extra SSH round trips per VM creation (realm read, grant script) and two per migration (ACL read, copy script)

**Constraints**: never fail the job; never log the realm's `client-key` or the cluster-wide ACL list; POSIX/bash per the `pve` branch of `runRemote`

**Scale/Scope**: one VM at a time; single cluster

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
| --- | --- | --- |
| I. No real operational data | PASS | Fixtures are captured live and redacted (example emails, realm `authentik`, VMIDs 4xxx). No operator default: the realm is opt-in, and the role default `PVEVMAdmin` is a stock Proxmox role, not an operator value |
| II. Code quality | PASS | All remote work goes through `runRemote`. Host output is zod-validated (`RealmInfoSchema`, `AclEntrySchema`). The logic lives once, in `src/lib/pve-acl.ts`. Errors name the setting or Proxmox screen that fixes them |
| III. Testing | PASS | `FakeSSHClient` only. The fixtures for the realm read, ACL read and missing-user error are captured from the live cluster (research R1–R5). No live test |
| IV. UX consistency | PASS (see R9) | The preview shows the grant. Settings go through the shared schema for `set-config` and the Settings page. The "grant to the signed-in creator" rule is identical across front ends; only the web UI has a signed-in person. Docs and CLAUDE.md are updated in the same change. The Settings page change gets desktop + ≤640px checks |

Post-design re-check: PASS. No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/016-pve-creator-acl/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/pve-acl.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/pve-acl.ts                         # NEW: mapping, scripts, grant, ACL copy
src/lib/inventory.ts                       # SettingsSchema: pveUserRealm, pveCreatorRole
src/operations/types.ts                    # OperationDeps.actor
src/operations/provisioning.ts             # create-vm preview line + grant in apply
src/web/impersonation.ts                   # resolveActor(req)
src/web/routes/provisioning.ts             # deps(req) sets actor for preview and apply
src/commands/provisioning/migrate-guest.ts # copyGuestAcls before destroy; preview line
web-client/src/pages/SettingsPage.tsx      # two always-visible fields
web-client/src/api/types.ts                # SettingsValues keys

test/lib/pve-acl.test.ts                   # NEW
test/fixtures/proxmox/*.json|txt           # NEW: captured, redacted
test/operations/provisioning.test.ts       # create-vm grant cases (extend)
test/commands/migrate-guest.test.ts        # ACL copy cases (extend; adjust preview asserts)
test/web/routes/provisioning.test.ts       # actor passed, impersonation → real user (extend)
test/lib/inventory*.test.ts / settings     # schema cases (extend)

docs/proxmox-access.md                     # NEW
docs/configuration.md, CLAUDE.md, README.md docs index
docs/images/ (Settings screenshot, regenerated)
```

**Structure Decision**: Follow the existing split. Infrastructure helpers
live in `src/lib/`, the operation glue in `src/operations/provisioning.ts`,
and the web adapter in the provisioning router. The CLI's `create-vm` command
is left untouched (no actor), and `migrate-guest`'s ACL copy lives in the
command function, so the CLI, web UI and MCP all get it.

## Complexity Tracking

None.
