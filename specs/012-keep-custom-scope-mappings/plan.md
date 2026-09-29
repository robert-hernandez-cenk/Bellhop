# Implementation Plan: Keep custom scope mappings on an OpenID client

**Branch**: `issue-16-keep-custom-scope-mappings` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-keep-custom-scope-mappings/spec.md`

## Summary

`diffOAuth2Settings` stops requiring an OpenID client's scope mappings to be exactly the three
built-in ones. It checks coverage by scope name instead: each of `openid`, `profile`, `email`
needs at least one attached mapping with that scope name, built-in or custom. A missing scope
is fixed by appending the built-in mapping while keeping every attached one. To know each
mapping's scope name, `AuthentikClient.getScopeMappingIds` becomes `listScopeMappings`, read
once per run inside `resolveOidcInstanceSettings`, which now also returns a
`scopeNameById` map. The listing's truncation guard is fixed to read `pagination.count`, as
the live response does (research R1). New clients are unchanged.

## Technical Context

**Language/Version**: TypeScript on Node.js (run with node's type stripping)

**Primary Dependencies**: none new; Authentik REST API v3 via global `fetch`

**Storage**: N/A (no inventory or database change)

**Testing**: `node --test` via `npm test`; `FakeAuthentikClient` for command logic, a stubbed
`fetch` with a redacted live fixture for `RealAuthentikClient`

**Target Platform**: the Bellhop CLI, web service and MCP server (all share this code)

**Project Type**: CLI + web service

**Performance Goals**: one scope-mapping listing per sync run / adoption (unchanged count)

**Constraints**: never rotate client credentials (the patch type still cannot carry them)

**Scale/Scope**: two source files, the fake client, three test files, one fixture, two docs

## Constitution Check

- **I. No real operational data**: the fixture is a redacted live capture; custom mapping
  name, description and expression are replaced with example values, every `pk` is a fake
  UUID. Spec artifacts use example values only. ✅
- **II. Code quality**: a narrow change to one function's rule plus one client method;
  comments follow the file's existing density. ✅
- **III. Testing standards**: unit tests for each acceptance scenario; the fixture is
  captured, not invented (which is what exposed the dead `count` guard). ✅
- **IV. UX consistency**: no output format change; dry run and apply share the same diff.
  README and CLAUDE.md updated in the same change (FR-008). ✅

Post-design re-check: unchanged, all pass. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-keep-custom-scope-mappings/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/interfaces.md
└── tasks.md
```

### Source Code (repository root)

```text
src/lib/authentik-client.ts                # AuthentikScopeMapping, listScopeMappings (real + unconfigured)
src/commands/networking/sync-authentik.ts  # resolveOidcInstanceSettings, diffOAuth2Settings, planOidc call sites
src/commands/networking/adopt-oidc-client.ts  # passes scopeNameById to diffOAuth2Settings
test/support/fake-authentik-client.ts      # scopeMappings seed as a list; listScopeMappings
test/fixtures/authentik/propertymappings-scope.json  # redacted live capture
test/lib/authentik-client.test.ts          # listScopeMappings mapping + truncation guard
test/commands/sync-authentik.test.ts       # diff rule + sync scenarios
test/commands/adopt-oidc-client.test.ts    # custom email mapping adoption
README.md, CLAUDE.md                       # narrowed drift meaning
```

**Structure Decision**: existing single-project layout; no new modules.
