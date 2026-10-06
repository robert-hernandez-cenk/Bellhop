# Research: Bellhop-Managed Web Login

No `NEEDS CLARIFICATION` remained after the issue discussion; these are the
design decisions, each with the alternatives weighed.

## R1 - How Bellhop identifies its own entry

**Decision**: an explicit `bellhop: true` flag on at most one guest (user's
choice on issue #85). Validated in `validateInventory()` beside the
`proxy`/`authentik` at-most-one rules; stored as a nullable integer column
`guests.bellhop` added with `ensureColumn`; read/written by the same
load/save pair as `authentik`. Guests only: the issue is about Bellhop in a
Proxmox guest.

**Alternatives**: detect by matching `/auth/callback` against request host
(breaks behind alternate hostnames, implicit); a `bellhopEntry` setting
(drifts on rename).

## R2 - Where the managed value is resolved, given `webLoginConfig()` is sync

**Decision**: a module `src/web/login/managed.ts` holds an in-memory
`ManagedLogin` (`{ entry, issuer, clientId, clientSecret, redirectUri }`) plus
the last error. `refreshManagedWebLogin()` is async: finds the flagged guest
in the live inventory, requires `effectiveAuth === 'oidc'` and a callback URL
with pathname exactly `/auth/callback` (same rule as the removed command),
then calls `runOidcCredentials(entry.name, { authentik, inventory })`. On
success it replaces the cache; on an Authentik error it keeps the last good
value and logs a secret-free warning; when there is no qualifying guest it
clears the cache. `webLoginConfig()` stays synchronous and reads the cache.

Refresh points: web service start; the start of `/auth/login` (and
`/auth/callback`, so a restart mid-flow still has a value); before a due
session re-check (`SessionService.recheck`). The re-check interval is 5
minutes, so the cache is at most that old when it is used for a re-check.
MCP's issuer reads the cache synchronously (the origin of the redirect URI
does not depend on the secret).

**Alternatives**: make `webLoginConfig()` async (touches the MCP authorization
server's synchronous issuer lookup and every test double: large churn for no
behavior gain); persist derived credentials into the settings store at
sync-authentik time (a second copy of a secret that drifts on rotation, and
contradicts "never persisted"); TTL-only cache without refresh on login
(a rotated secret would fail sign-in until the TTL elapsed).

## R3 - Precedence

**Decision**: custom wins when all four values are set (user's choice).
"Complete" uses the same `configValue` reads `webLoginConfig` already does
(environment pins included). A partial custom set is not mixed: the result is
the managed value if it qualifies, else `configured: false` with the missing
custom keys (what the page shows today) so the existing unconfigured
messages still name settings.

**Alternatives**: managed wins (silently overrides an existing deployment);
refuse the combination (blocks the unmanaged-to-managed move for no gain).

## R4 - Active-source status for the Settings page

**Decision**: `webLoginStatus(env?)` in `managed.ts` returns
`{ source: 'custom' } | { source: 'managed', entry, redirectUri } | { source: 'none', missing: ConfigKey[], managedProblem?: string }`.
`settingsResponse` adds it as `webLogin`. `managedProblem` is a fixed-text
reason (no flagged guest / not OIDC-gated / no `/auth/callback` URL / client
not found / Authentik unreachable) with no secret. The status is computed
from the live inventory plus the cache (no network call in a GET).

## R5 - Settings group and tab

**Decision**: add `'weblogin'` to `SettingGroup` and move the four keys to it;
the client's `SettingsTab`/`fieldsForTab` gain a "Web login" tab whose
description states it is for installs not managed by Bellhop in Proxmox and
which renders the active-source line. `webUiAuthMode` stays in `general`.
No env var or `authentik.env` mapping changes (`envVar`/`envFile` keep their
values, so env-pinned notes still work).

## R6 - Fixtures and secrets

**Decision**: the managed path reuses `runOidcCredentials` and the existing
`AuthentikClient` interface unchanged, so no new third-party response shape
is consumed and no new captured fixture is needed (Constitution III). Tests
use the existing fake `AuthentikClient` from the `runOidcCredentials` tests.
Secrets: the managed secret is only ever a field of the in-memory object; no
function that renders a response or log takes it; a test asserts it is absent
from the settings response, the not-configured page, and logged lines.

## R7 - PATCH guard changes

**Decision**: when the mode is (or is becoming) `oidc`:
- switching to oidc: "configured" = every custom key set after the request,
  **or** `webLoginStatus()` is `managed` (guarding on the cache after an
  awaited refresh, so the guard sees current Authentik state). The existing
  session and admin checks are unchanged. Message when neither: names both
  ways (flag Bellhop's own guest in the guest editor, or fill in the Web
  login tab).
- already oidc: the "refusing to clear" check applies when the complete
  custom set is what is in effect, even if a flagged guest could take over
  (sessions made through the custom client would be re-checked against a
  different client and signed out; found in code review). With the custom
  set already incomplete and a managed source in effect, clearing a stray
  custom value is allowed.

## R10 - Review follow-ups

- A guest edit that stops the flagged guest qualifying, while oidc is required
  and the custom set is not in effect, is refused in `commitGuestEdit`
  (`managedLoginLockoutError`): otherwise the next re-check signs everyone
  out with the web UI unreachable.
- A saved guest edit refreshes the managed login (MCP reads it
  synchronously).
- On an Authentik error the last good value is kept only while it is still the
  flagged guest's client at the same callback.
- `refreshManagedWebLoginIfUsed` skips the lookup while all four custom values
  are set, so custom-only installs never depend on Authentik for web login.
- When several `/auth/callback` URLs are listed the first is used
  (documented). The single-flight window that lets a caller join a lookup
  begun just before an edit is accepted: seconds long, one operator.

## R8 - Removing `configure-web-login`

**Decision**: delete the command file, its CLI registration and tests, and
every doc reference. Pre-release project: no shim. Its `callbackUri` helper
moves to `managed.ts`. Existing stored custom values keep working (custom
wins), so a live deployment loses nothing. `OIDC_SCOPE_MAPPINGS` still
includes `offline_access`, which the managed client needs unchanged.

## R9 - Single-operator assumptions (recorded in nested CLAUDE.md)

Exactly one Bellhop guest and one web origin; the flag is guest-only; the
managed login needs Authentik reachable at start/sign-in or a previously
resolved value.
