# Feature Specification: One settings store, with write-only secrets

**Feature Branch**: `issue-64-one-settings-store`

**Created**: 2026-10-04

**Status**: Draft

**Input**: GitHub issue #64 -- "One settings store: move data/*.env config into Settings, with
write-only secrets (incl. a GitHub API token)", plus decisions made while designing it (see
Assumptions).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Change integration configuration from the Settings page, no restart (Priority: P1)

An administrator needs to change how Bellhop reaches Authentik or Nginx Proxy Manager -- the
API URL, the admin group names, the group ladder, the outpost name -- or replace an expired API
token. Today that means getting a shell on the host, editing a hand-written `data/*.env` file,
and restarting the service. With this feature every one of those values is a setting: the
administrator changes it on the Settings page (or with `set-config` on the CLI), and the very
next request uses the new value.

**Why this priority**: it removes the two-store split that is the core problem of the issue and
is the foundation every other story builds on.

**Independent Test**: on a running web service, change the Authentik API URL and token in
Settings; the next Users-page request reaches the new address with the new token, without a
restart. Change the admin group name; the next request's admin check uses it.

**Acceptance Scenarios**:

1. **Given** the web service is running, **When** an administrator saves a new value for any
   moved setting, **Then** the next request that uses that setting uses the new value, with no
   restart.
2. **Given** a value was saved through the web UI, **When** a CLI command or the MCP server runs
   afterwards, **Then** it uses the same value.
3. **Given** the Settings page, **When** an administrator opens it, **Then** settings are grouped
   by integration -- General, Proxy, Authentik, Cloudflare, Nginx Proxy Manager, GitHub -- and
   each secret sits next to the settings it belongs to.

---

### User Story 2 - Secrets are write-only (Priority: P1)

An administrator enters an API token or password once. Bellhop uses it, but never shows it
again to anyone -- not on the Settings page, not in any API response, log line, job record, error
message, status page or inventory snapshot. The page only says whether the secret is set and
where the value comes from, and offers Replace and Clear.

**Why this priority**: moving credentials into a store the web UI can reach is only safe if the
web UI can never read them back.

**Independent Test**: set every secret to a recognisable value, exercise the Settings API,
status page, a job, the logs and an inventory snapshot, and search every output for the value.

**Acceptance Scenarios**:

1. **Given** a secret is set, **When** the settings are read through the API, **Then** the response
   says only "set" and the source, with no part of the value.
2. **Given** the Settings page, **When** an administrator replaces a secret and saves, **Then** the
   input is empty again and the field shows "set".
3. **Given** an administrator clears a secret, **When** the page reloads, **Then** the field shows
   "not set" and the integration behaves as unconfigured.
4. **Given** the CLI, **When** a secret is given as a command-line argument, **Then** the command
   refuses and says to use `--stdin` (or the prompt); **When** it is piped on standard input with
   `--stdin`, **Then** it is accepted.
5. **Given** the MCP server, **When** its tools are listed, **Then** none reads a secret, and its
   settings tool cannot write one.

---

### User Story 3 - Authenticated GitHub requests (Priority: P2)

The daily app update check, the custom script repository's pin and compare, and the install-app
catalog all call GitHub's API, and today share GitHub's anonymous limit of 60 requests per hour.
An administrator sets a GitHub API token once and every one of those requests is authenticated.

**Why this priority**: it is the new capability the issue started from, but it is only safely
possible once secrets exist (Story 2).

**Independent Test**: with the token set, every request to GitHub's API from each of the three
call sites carries the token; with it unset, none does.

**Acceptance Scenarios**:

1. **Given** the GitHub token is set, **When** any of the three features calls GitHub's API,
   **Then** the request carries the token.
2. **Given** the GitHub token is not set, **When** they run, **Then** behavior is exactly as today.
3. **Given** a token GitHub rejects, **When** a request fails as unauthorized, **Then** the error
   names the GitHub token setting and the Settings page, and does not contain the token.

---

### User Story 4 - Existing deployments move over automatically (Priority: P2)

An operator who already runs Bellhop with `data/authentik.env`, `data/cloudflare-api.env` and
`data/nginx-proxy-manager.env` upgrades. On first start, every value in those files that has no
stored setting yet is imported into the settings store, and the log says which keys were
imported, never their values. The files are left untouched. While a file is still present it
keeps overriding the stored value, and the Settings page shows that field as "set by
environment" so the operator can see what to remove. Once satisfied, the operator deletes the
files.

**Why this priority**: without it, upgrading would silently drop every integration's
configuration.

**Independent Test**: start the service against a database with no stored integration settings
and a populated `data/*.env` set; every value is stored, the log names only the keys, and a
second start imports nothing and changes nothing.

**Acceptance Scenarios**:

1. **Given** a key has no stored value and a `data/*.env` file has one, **When** any entry point
   starts (web service, CLI, MCP server, Windows service installer), **Then** the value is
   stored and the import is logged by key name only.
2. **Given** a key already has a stored value, **When** startup runs, **Then** the stored value is
   never overwritten.
3. **Given** the import ran, **When** the files are inspected, **Then** they are byte-for-byte
   unchanged.

---

### User Story 5 - Environment variables still override (Priority: P3)

A deployment that pins values through environment variables keeps working. If the environment
sets a value, it wins over the stored value; the Settings page shows that field read-only,
labelled "set by environment"; and the API reports "environment" as its source.

**Why this priority**: keeps existing deployments and recovery paths working; it is also the
mechanism that makes a still-present `data/*.env` file visible (Story 4).

**Independent Test**: set an environment variable for one moved key and start the web service;
the field is read-only with the label, the API reports source "environment", the value in use
is the environment's, and a web write to that field is refused naming the variable.

**Acceptance Scenarios**:

1. **Given** an environment variable is set for a moved key, **When** the value is read anywhere,
   **Then** the environment value is used.
2. **Given** the same, **When** an administrator tries to save that field through the web UI,
   **Then** the save is refused with a message naming the environment variable.
3. **Given** the same, **When** the CLI's `set-config` writes that key, **Then** it stores the
   value but warns that the environment overrides it (the CLI's environment is not necessarily
   the service's).

---

### User Story 6 - No self-lockout through Settings (Priority: P2)

Three settings decide who can use the web UI: the two admin group names and the web UI's
authentication mode. An administrator must not be able to lock themselves out by saving one of
them.

**Why this priority**: Bellhop has no login page of its own -- it trusts identity headers from
the reverse proxy -- so a bad save could leave no way back in through the UI.

**Independent Test**: as a real admin whose only admin membership is the configured admin group,
try to rename that group to one they are not in; the save is refused. Try to switch the auth mode
to `authentik` from a request with no Authentik identity headers; refused. Each guarded field asks
for confirmation in the UI.

**Acceptance Scenarios**:

1. **Given** a real (not impersonating) administrator, **When** they save admin-group values under
   which they would no longer be an administrator, **Then** the save is refused and nothing
   changes.
2. **Given** an admin-group field, **When** an administrator saves it in the UI, **Then** they are
   asked to confirm first.
3. **Given** a request that did not arrive with verified Authentik identity headers, **When** it
   tries to set the auth mode to `authentik`, **Then** it is refused, because every later request
   from that browser would be rejected.
4. **Given** the auth mode is currently `authentik`, **When** an administrator changes it to
   anything else, **Then** the UI asks for confirmation that the web UI will become reachable
   without signing in.
5. **Given** a lockout happened anyway, **When** the operator sets the environment variable or
   runs `set-config` on the host, **Then** access is restored without the web UI.

---

### Edge Cases

- A stored setting is malformed (e.g. a non-numeric outpost port written straight into the
  database): reading it must fail with an error naming the setting, never a silent fallback;
  every write path validates first so normal use cannot produce one.
- An environment variable for a moved key is set but empty: treated as unset (same rule as today).
- The database is opened for the first time by an older layout that still needs the one-time
  `requires_auth` -> `auth_group` migration: the migration reads the group ladder from that same
  database's settings (with the environment overriding), so it uses the operator's configured
  ladder even before the import has run, or from the environment value that the import will copy.
- Only some secrets are set (e.g. Authentik URL without a token): the integration is
  "not configured", exactly as when either environment variable is missing today.
- The CLI runs `set-config` for a secret with `--stdin` but nothing on standard input: refused as
  an empty value; `--unset` is how to clear.
- A secret is set both in the environment and in the store: the environment wins, and clearing
  the stored value through the web UI is refused like any other environment-pinned field.
- A web request is made by an administrator impersonating a non-admin group: settings reads and
  writes are refused (unchanged from today).
- The admin-group guard is evaluated against the requesting administrator's real groups, not an
  impersonated group, and the local operator (no identity provider) is always an administrator,
  so the guard never blocks them.

## Requirements *(mandatory)*

### Functional Requirements

**Configuration sources**

- **FR-001**: These values MUST be ordinary settings, stored with the existing settings and
  editable on the Settings page and with `set-config`: Authentik API URL, admin group, built-in
  admin group, group ladder, outpost name, outpost port, authorization flow slug, invalidation
  flow slug, OIDC signing key name; Nginx Proxy Manager API URL and login email; and the web UI
  authentication mode. Their names follow the existing camelCase convention (`authentikApiUrl`,
  `npmApiEmail`, `webUiAuthMode`, ...).
- **FR-002**: These values MUST be secret settings: Authentik API token, Cloudflare DNS API
  token, Nginx Proxy Manager password, and a new GitHub API token.
- **FR-003**: Each moved setting MUST keep its current environment variable name as an override
  (`AUTHENTIK_API_URL`, `WEB_UI_AUTH_MODE`, ...); the new GitHub token's is `GITHUB_API_TOKEN`.
- **FR-004**: `PORT`, `WEB_DATA_DIR`, `INVENTORY_FILE`, `WEB_UI_LOCAL_USER`,
  `WEB_UI_DEV_USER`/`WEB_UI_DEV_GROUPS` and `SSH_AUTH_SOCK` MUST remain environment-only.
  VPN deploy credentials, `NFS_SERVER`/`FSTAB_PATH` and Caddy's own `CLOUDFLARE_API_TOKEN` are
  out of scope and unchanged.
- **FR-005**: Every consumer of a moved value MUST read it through one accessor at the point of
  use, with precedence environment variable, then stored value, then the built-in default (or
  "not set"). No moved value may be read once at startup and cached for the life of the process.
- **FR-006**: A value saved by any front end MUST take effect on the next request in the web
  service, and on the next run of the CLI or MCP server, with no restart.
- **FR-007**: Secret and non-secret settings MUST be validated by the same rules in every front
  end that can write them.

**Secrets**

- **FR-008**: Secret values MUST be stored separately from the other settings and MUST NOT be
  part of the in-memory inventory, the status page, or any inventory snapshot.
- **FR-009**: The settings API MUST report each secret only as set or not set, plus its source
  (settings, environment, none). It MUST NOT return the value or any part of it.
- **FR-010**: The Settings page MUST show each secret as a masked input with Replace and Clear
  actions and no way to reveal the value; the input MUST be empty after a save.
- **FR-011**: `set-config` MUST accept a secret only from standard input (`--stdin`) or a prompt
  that does not echo, MUST clear one with `--unset`, and MUST refuse a secret value given as a
  command-line argument. Its dry run MUST NOT print the value.
- **FR-012**: No MCP tool may read or write a secret; the MCP settings tool MUST NOT accept a
  secret key.
- **FR-013**: A secret value MUST NOT appear in API responses, logs, job logs, the jobs database,
  error messages, or the status page. Errors MUST name the setting, not the value.

**Settings page**

- **FR-014**: The Settings page MUST group settings by integration as General, Proxy, Authentik,
  Cloudflare, Nginx Proxy Manager and GitHub, usable at 640px wide or narrower and in light and
  dark themes. The existing per-proxy-driver show/hide rules MUST keep working.
- **FR-015**: Every setting's source MUST be reported by the API, and a field whose value comes
  from the environment MUST be shown read-only, labelled "set by environment".
- **FR-016**: A web write to a field whose value comes from the environment MUST be refused with
  a message naming the environment variable. The CLI MUST store it and warn instead.

**Import**

- **FR-017**: At startup, the web service, CLI, MCP server and Windows service installer MUST,
  for each moved key with no stored value, import the value from the matching `data/*.env` file
  (`authentik.env`, `cloudflare-api.env`, `nginx-proxy-manager.env`) when that file has one.
- **FR-018**: The import MUST be idempotent, MUST NOT overwrite a stored value, MUST log only key
  names, and MUST NOT modify or delete the files.
- **FR-019**: A `data/*.env` file that is still present MUST keep acting as an environment
  override.
- **FR-020**: The one-time `requires_auth` migration MUST read the group ladder through the same
  accessor, from the database being opened.

**Guards**

- **FR-021**: A change to either admin-group setting MUST be refused when, under the new values,
  the requesting real (non-impersonated) administrator would no longer be an administrator.
- **FR-022**: Setting the auth mode to `authentik` through the web UI MUST be refused unless the
  saving request itself carried verified Authentik identity headers.
- **FR-023**: The UI MUST ask for confirmation before saving either admin-group field, and before
  saving an auth mode change away from `authentik`.
- **FR-024**: Reads and writes of settings MUST stay restricted to administrators; a non-admin or
  an administrator impersonating a non-admin group MUST get 403 (unchanged).

**GitHub**

- **FR-025**: One helper MUST build the headers for every GitHub API request; when the GitHub
  token is set it MUST add it as a bearer token, and when unset requests MUST be unchanged. All
  three call sites (app update check, custom script repository, install-app catalog) MUST use it.
- **FR-026**: An unauthorized response from GitHub MUST produce an error naming the GitHub token
  setting and the Settings page.

**Demo, docs**

- **FR-027**: The demo instance MUST seed example values only, including secrets in the "set"
  state.
- **FR-028**: User docs (`docs/environment-variables.md`, `docs/configuration.md`,
  `docs/web-ui.md`, `docs/authentik.md`, README where relevant), `CLAUDE.md` and
  `CONTRIBUTING.md` MUST describe the new store, the overrides, the import and the deletion of
  the old files; the docs MUST note that a fine-grained GitHub token with no repository
  permissions is enough for public repositories; the #63 "unauthenticated GitHub API"
  single-operator note MUST be removed.

### Key Entities

- **Setting**: a named, validated configuration value. Has a key, an integration group, whether
  it is secret, an optional overriding environment variable, and an optional default.
- **Stored value**: the value saved in the settings store for a setting, if any. Secret stored
  values are kept apart from non-secret ones.
- **Effective value**: what a consumer actually uses -- the environment override if set, else
  the stored value, else the default -- together with its source (environment, settings, none).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator can change any integration setting or credential and have it in
  effect on the next action, with zero restarts and zero shell access to the host.
- **SC-002**: Across every API response, log, job record, jobs database row, status page and
  inventory snapshot produced in the test suite, a secret value appears 0 times.
- **SC-003**: After an upgrade with existing `data/*.env` files, 100% of their moved values are
  present in the settings store on first start, and a second start changes nothing.
- **SC-004**: With a GitHub token set, 100% of requests to GitHub's API from the three features
  carry it; with none set, 0% do.
- **SC-005**: Once the import is confirmed and the `data/*.env` files are deleted, a production
  deployment still requires sign-in, because its auth mode is stored with the other settings.
- **SC-006**: No single save through the web UI can leave the saving administrator without
  access to the web UI.

## Assumptions

- **The web UI auth mode becomes a setting** (decided while designing, reversing the issue's
  "environment-only" rule). Under the default `auto` mode an unauthenticated request is already a
  full administrator, so a web-editable mode adds no new power; the real risk is lockout, which
  FR-022/FR-023 and the environment/CLI recovery paths address. This is what lets every
  `data/*.env` file be deleted.
- Secrets stay plain text on disk in the inventory database, as they are in today's `.env` files.
  Write-only means Bellhop never returns a value; it is not encryption at rest. Backups and copies
  of the database carry the secrets.
- Copying the inventory database into a new worktree now brings settings and secrets along;
  separately copying `data/*.env` is no longer needed.
- Only real values that exist today in `data/*.env` files are imported; values set only as real
  environment variables are honoured as overrides but not imported.
- The CLI warns rather than refuses when its own environment overrides a key, because it does not
  share the service's environment.
- Settings remain a single-operator homelab feature; one administrator at a time, so concurrent
  edits of the same setting are not guarded beyond last-write-wins.
