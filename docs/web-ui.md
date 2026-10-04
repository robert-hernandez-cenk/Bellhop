# Web UI

A browser dashboard for everything in [Commands](commands.md), instead of
the CLI:

```bash
npm run web:dev                   # dev server: API on :3001, Vite dev server with hot-reload
npm run web:build                 # production build of web-client/dist
npm run web:start                 # production: one Express server serving both the API and the built UI, on :3001
```

`src/web/server.ts` is a single Express process that's both the backend
*and* the frontend in production (`web:start`) — it mounts every
`/api/*` route (dashboard, jobs, provisioning, maintenance) and serves
`web-client/dist`'s built static files with a catch-all fallback to
`index.html`. Only `web:dev` runs a separate frontend process (Vite's dev
server, for hot-reload), proxying API calls to the same backend.

## Demo

```bash
npm run web:build
npm run demo
```

Prints `Bellhop demo running at http://127.0.0.1:3100 -- example data only,
nothing reaches a real host. Press Ctrl+C to stop.` and serves the same web
UI against a throwaway, fully populated example inventory — two Proxmox
hosts, a handful of guests in various states, four job-history entries, and
a signed-in `admin` user — with no Proxmox host, Authentik instance, or SSH
key required. Every write (a guest edit, an install-app run, a settings
change) lands only in a temporary directory that `Ctrl+C` removes along with
the server; the repository's own inventory and `data/` are never read or
written. Stopping and starting it again always comes back to the same
starting data. To run it on a port other than `3100`, set `PORT` to another
port: `PORT=3200 npm run demo` in a POSIX shell, or `$env:PORT=3200; npm run demo`
in PowerShell.

The Dashboard shows inventory (hosts, guests, bridges, storages). Each guest
row has its own Start/Shutdown icon buttons (`guest-power` under the hood)
for one-off actions without opening a form. A guest row's Advanced link
opens a modal with its less-common fields (auth group, unauthenticated
paths, vpn, and the rest); each one has an ⓘ next to its label with a
one-to-two-sentence explanation, reachable by hover, tap or keyboard.

On a phone-width screen (640px or narrower) the sidebar folds into a menu
button and every table becomes a stack of cards, one per row, each value
labelled with its column name:

![The Bellhop Dashboard on a phone: a menu button and page title at the top, two host cards listing name, MID scheme and SSH target, then the guest filter and the first guest card with its type, IP address, subdomain and power buttons](images/dashboard-phone.png)

Provisioning actions (create-lxc/create-vm/install-app/deploy-vpn-gateway/
delete-guest/migrate-guest/attach-nfs-mount/migrate-nfs-mount) and
maintenance actions (sync-inventory) run from forms instead of flags. Forms
with an MID field suggest the lowest MID free on the selected host, counting
every guest on it, including guests your group is not allowed to see (their
names are never shown). The
Install App form's App field suggests community-scripts apps as you type,
grouped by repository:

![The Install App form with "ar" typed into the App field and a suggestion list open below it, showing matching apps under "ProxmoxVE (stable)" and "ProxmoxVED (development)"](images/install-app-catalog.png)

Every action streams its live log via WebSocket on a Job page, and every job
also lands in Job History afterward:

![A finished install-app job's page in the dark theme, with a SUCCESS badge and the full log of creating and installing the jellyfin container](images/job-log.png)

Updating apt packages and community-script apps has its own dedicated
`/update` page instead, showing a card per host/guest with an apt-update
icon and, for guests with an app installed, a second community-script-update
icon:

![The Update page: a card per Proxmox host with an OS-package update button, and a card per guest with the installed app's name and buttons for an OS-package update and a community-script update](images/update-page.png)

Next to a guest's app name, the Update page also shows the result of the
once-a-day app update check (see `check-app-updates` in
[Commands](commands.md)): a prominent "Update available 1.2.3 → 1.3.0"
badge when a newer release exists, with the guest's community-script-update
button visually emphasized to match, or a quiet note ("Up to date",
"Update check failed", "Not checked: guest is stopped") for every other
outcome — an app whose script has no recognizable release check shows
nothing at all, never an error. Tapping or clicking the badge or note shows
when it was last checked (and, for a failure, why). After a successful
app update from this page, that guest's result is refreshed immediately as
part of the same job, rather than waiting for the next daily run.

The Admin section of the sidebar (visible to admins only) has a Tasks page
alongside Users/Permissions/Settings, listing every scheduled background
task the web service runs on its own — today, just the app update check.
For each task it shows its schedule, whether it's enabled, its last run
(with a link to that run's Job History entry) and its next scheduled run,
and lets an admin change the time of day, turn it off or on, or press "Run
now" to start it immediately. A scheduled or manual run shows up in Job
History like any other job, attributed to "scheduler" or to the admin who
ran it. Only the web service runs tasks on a schedule — the CLI and MCP
server never do; a task missed because the service was down runs once,
shortly after it starts back up. A task runs on its schedule at most once
per calendar day: after a run (scheduled or "Run now"), moving the time
later that same day takes effect from the next day. Stopping a run from
Job History saves none of its results.

Changes that touch
subdomains (a new guest's Subdomains field, editing an existing guest's
subdomains, deleting a guest that had any) automatically re-run
`sync-proxy` and `render-status-page` in the same job, so the live
proxy configuration and status page never drift from what the Dashboard
shows. Set `PORT` to run it on a port other than 3001.

The deployed web UI can be gated behind its reverse proxy's Authentik
forward-auth (Caddy's `forward_auth`, nginx's `auth_request`), checking
every request against a self-hosted Authentik instance and forwarding
trusted `X-authentik-*` identity headers on success. (The HAProxy driver
can't generate forward-auth, so under it you front the web UI yourself —
see [HAProxy limits](reverse-proxy/haproxy.md#limits).) There is no login
page or session store in this app itself, only a global Express middleware
(`src/web/auth.ts`) that trusts those headers when present. Whether a
request arriving with no such headers is rejected or served as a synthetic
always-admin local operator is controlled by the `webUiAuthMode` setting
(the `WEB_UI_AUTH_MODE` environment variable overrides it — see [Sign-in
mode](environment-variables.md#sign-in-mode) and [Running without
Authentik](authentik.md#running-without-authentik)). The default `auto`
mode falls back to the local operator, so running `web:start`/`web:dev`
directly (not routed through the proxy) works out of the box instead of
401ing the whole dashboard; store `webUiAuthMode` as `authentik` on any
deployment where authentication is load-bearing, so a request that
bypasses forward-auth fails closed. `WEB_UI_DEV_USER` remains useful in
dev/test for simulating a *specific non-admin group membership*, which the
synthetic local operator can't do — `web:dev` sets it automatically (to
`local-dev`) and `npm test` sets it too (to `test-user`).

## Settings page

Admins reach the Settings page from the Admin group in the sidebar. It
holds every setting described in [Configuration](configuration.md), one
tab per integration: General, Proxy, Authentik, Cloudflare, Nginx Proxy
Manager and GitHub. Each field saves on its own, and a saved value is in
use from the very next request — nothing needs a restart. The Proxy tab's
fields still appear and disappear with the selected proxy driver (see
[Reverse proxy drivers](reverse-proxy/README.md)).

- **Secrets** (the Authentik API token, the Cloudflare DNS API token, the
  Nginx Proxy Manager password and the GitHub API token) show only "Set" or
  "Not set" and where the value comes from. Each is a masked input with
  Replace (or Save, when unset) and Clear; it is never pre-filled, has no
  reveal control, and is empty again after every save. See
  [Secrets](configuration.md#secrets).
- **Fields set by the environment** are read-only, labelled "set by
  environment" with the variable's name, and have no Save or Clear: the
  environment variable wins over anything saved here, so the server
  refuses the write. Each also shows its "Stored copy" — the value saved
  underneath (a secret only says "set"), or "not set" — so you can confirm
  the import before deleting a `data/*.env` file. Unset the variable (or
  remove it from its `data/*.env` file) and restart the service to manage
  the field here again — see [The data/*.env
  files](environment-variables.md#the-dataenv-files).
- **Admin groups.** Saving the admin group or the built-in admin group asks
  for confirmation first, and is refused when, under the new names, you
  would no longer be an administrator yourself. The check uses your real
  groups even while impersonating, and never blocks the local operator.
- **Web UI sign-in** (`webUiAuthMode`). Switching it to `authentik` is
  refused unless the save itself carries Authentik's forward-auth headers
  and the user they name is an administrator (under the admin groups as
  they will be after the save) — otherwise the next request from your
  browser would be rejected or lose this page. The headers are checked
  even in `none` mode, which otherwise ignores them. Switching away from
  `authentik` asks for confirmation, since the web UI then becomes
  reachable without signing in, and the service log records who did it. If a wrong value locks you
  out anyway, see [Locked out](authentik.md#locked-out).

Settings stays in the nav for any admin even without Authentik's user
directory; Users and Permissions need it.

## Screenshots

The images on this page and in `README.md`/`docs/authentik.md`/
`docs/reverse-proxy/README.md` are captured from a throwaway demo instance,
not a real deployment. Regenerate all of them with:

```bash
npm run web:build
npm run docs:screenshots
```

This needs Google Chrome or Microsoft Edge installed (it also works with
Playwright's own bundled Chromium after `npx playwright install chromium`).
It writes every file under `docs/images/` and prints one `wrote
docs/images/<file>` line per image; after a UI change that alters a
screenshotted screen, regenerate and check the new images by eye for
example-only values before committing them.
