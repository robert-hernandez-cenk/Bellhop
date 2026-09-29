# Feature Specification: Web UI screenshots from a demo instance

**Feature Branch**: `issue-45-readme-screenshots`

**Created**: 2026-09-29

**Status**: Draft

**Input**: Issue #45, "Show the web UI in the README with screenshots, captured reproducibly from demo data."

## Background

The README and the `docs/` pages (split out of the README by #41) describe Bellhop entirely in
prose, command tables, and flags. The web UI is the part of the project that turns a set of
scripts into a self-hosted app store, but no page shows it. A visitor has to install and
configure the whole toolkit against real Proxmox hosts before seeing what they would get.

Every tracked file, images included, must contain example values only (constitution,
Principle I). Screenshots therefore cannot be taken from a real deployment. They come from a
demo instance that runs the real web UI against invented, example-only data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor sees the web UI while reading the docs (Priority: P1)

Someone evaluating Bellhop opens the README on GitHub. Right after the introduction they see
the Dashboard: hosts, guests with their subdomains, access tiers, and power controls. As they
follow links into the documentation, each page that describes a screen shows that screen next
to the text: installing an app from the catalog, a job's live log, the Update page, the phone
layout, the guest access settings, and the proxy driver setting.

**Why this priority**: This is the problem the issue names. Without it, nothing else in this
feature has an audience.

**Independent Test**: Open the README and each changed documentation page in a Markdown
renderer. Every screenshot loads, sits next to the text it illustrates, has alt text that
describes it, and shows only example values.

**Acceptance Scenarios**:

1. **Given** the README, **When** a reader scrolls past the introduction, **Then** a Dashboard
   screenshot appears before the Prerequisites section.
2. **Given** the Web UI documentation page, **When** a reader reaches the part describing the
   app catalog, a job's log, the Update page, or the phone layout, **Then** a screenshot of that
   screen appears there.
3. **Given** the Authentik page's OIDC section and the reverse proxy overview page, **When** a
   reader reaches the text about per-guest access settings or choosing a proxy driver,
   **Then** a screenshot of that setting appears there.
4. **Given** any screenshot, **When** it is inspected, **Then** every hostname, domain, IP
   address, and user it shows is an example value from the constitution's table.

---

### User Story 2 - A maintainer regenerates every screenshot with one command (Priority: P2)

After changing the web UI, the maintainer runs one command. It starts the demo instance,
captures every screenshot at its defined size and theme, writes them over the committed
images, and shuts the demo instance down again. It needs no Proxmox host, no Authentik, no
network access beyond the local machine, and no real inventory.

**Why this priority**: Screenshots that cannot be regenerated go stale with the first UI
change, and a stale screenshot misleads readers. The images from Story 1 should be the output
of this command.

**Independent Test**: In a fresh checkout with no `data/` directory and no inventory
database, run the capture command. It finishes successfully and produces the full set of
images; running it twice in a row produces images that show the same content.

**Acceptance Scenarios**:

1. **Given** a checkout with dependencies installed and a supported browser available,
   **When** the maintainer runs the capture command, **Then** every screenshot in the defined
   set is written to the documentation images folder and the command exits successfully.
2. **Given** no supported browser can be found, **When** the capture command runs, **Then** it
   stops before starting anything and prints what it looked for and how to install one.
3. **Given** a real inventory database and real credential files exist in the checkout,
   **When** the capture command runs, **Then** it neither reads nor modifies either.
4. **Given** the capture command has finished or failed, **When** the maintainer checks for
   running processes, **Then** no demo server or browser process it started is still running.

---

### User Story 3 - Anyone tours the web UI without infrastructure (Priority: P3)

A prospective user or new contributor runs one command and gets the real web UI in their
browser, populated with the same example homelab the screenshots show. They can browse every
page, open forms, preview actions, and edit guests. Nothing they do reaches a real machine,
and everything they change disappears when the demo stops.

**Why this priority**: It reuses the demo instance Story 2 needs anyway, and it answers "what
is this like to use?" better than any static image. It is not needed for the screenshots
themselves.

**Independent Test**: Run the demo command in a checkout with no real inventory, open the
printed address, click through each page in the sidebar, save an edit to a guest, and stop
the demo. Every page renders with example data, and the checkout is unchanged afterward.

**Acceptance Scenarios**:

1. **Given** a built web UI, **When** a user runs the demo command, **Then** it prints a local
   address, and opening it shows the Dashboard populated with the example homelab.
2. **Given** the demo is running, **When** the user runs an action that would normally reach a
   Proxmox host, **Then** it completes against simulated responses and never opens a network
   connection to any host.
3. **Given** the user edited guests during the demo, **When** they stop it and start it again,
   **Then** the demo starts from the original example data.
4. **Given** the web UI has not been built, **When** the user runs the demo command, **Then** it
   says so and names the build command, rather than serving a blank page.

---

### Edge Cases

- The demo's port is already in use: the demo command reports the conflict and exits; the
  capture command picks a free port itself, so it never collides.
- A screen fails to reach the expected state (a missing element after a UI change): the capture
  command fails and names the screenshot it could not take, rather than writing a
  half-rendered image.
- The app catalog would normally be fetched from GitHub: in the demo it is served from a
  fixed list kept in the repository, so the capture works offline and the screenshot does not change when
  the upstream catalog does.
- Live timestamps (job start times, relative times such as "3 minutes ago"): the demo's
  seeded jobs use fixed times, so regenerated images differ only where the UI changed.
- A developer's own `data/*.env` sets `WEB_UI_AUTH_MODE=authentik` or Authentik credentials:
  the demo ignores them and always runs as a local operator with no Authentik.
- The Users and Permissions pages need a real Authentik instance, so the demo hides them the
  same way any deployment without Authentik does. They are not screenshotted.

## Requirements *(mandatory)*

### Functional Requirements

**Demo instance**

- **FR-001**: The project MUST provide a demo instance that runs the real web UI (the same
  pages and API the production web service serves) against a demo inventory created fresh in a
  temporary location each time it starts.
- **FR-002**: The demo inventory MUST contain only values from the constitution's example-data
  table, and MUST be rich enough to show every screenshotted screen with representative
  content: at least two Proxmox hosts, at least eight guests covering both container and VM
  types, several guests with subdomains, guests at more than one access tier, at least one
  guest in OIDC mode, several guests with an installed app, and a mix of running and stopped
  guests.
- **FR-003**: The demo instance MUST answer every request that would normally reach a Proxmox
  host with simulated responses, and MUST NOT open a network connection to any host.
- **FR-004**: The demo instance MUST serve the install-app catalog from a fixed list of app
  names kept in the repository, not from GitHub. The list may use well-known public app names;
  those are public software names, not operational data.
- **FR-005**: The demo instance MUST start with a few finished jobs, each with a log, and those
  jobs MUST use fixed timestamps.
- **FR-006**: The demo instance MUST NOT read or write the checkout's real inventory database,
  its `data/` directory, or any credential file, and MUST run as the local operator with
  Authentik and Cloudflare unconfigured, regardless of the developer's environment.
- **FR-007**: Everything the demo instance writes MUST go to its temporary location, which MUST
  be removed when the demo stops.
- **FR-008**: The project MUST provide a `demo` command that starts the demo instance on a local
  port, prints its address, and keeps running until stopped. It MUST fail with a message naming
  the build command when the web UI has not been built, and with a clear message when the port
  is taken.

**Screenshot capture**

- **FR-009**: The project MUST provide a `docs:screenshots` command that starts the demo
  instance on a free port, captures the defined set of screenshots, writes them to
  `docs/images/`, and stops the demo instance and browser it started, on success and on failure.
- **FR-010**: The capture command MUST use a browser already installed on the machine, and MUST
  NOT add a browser download to the project's normal dependency install. When no supported
  browser is found, it MUST stop before starting the demo and print what it looked for and how
  to install one.
- **FR-011**: The defined set MUST include at least: the Dashboard (desktop), the install-app
  form with the catalog suggestions open, a job's log view, the Update page, the Dashboard at a
  phone-width viewport (640px or narrower), the guest Advanced modal's Access tab for the OIDC
  guest, the Settings page's proxy driver setting, and one screen in the dark theme.
- **FR-012**: The capture command MUST wait for each screen to finish loading before capturing
  it, and MUST fail, naming the screenshot, when a screen does not reach its expected state.
- **FR-013**: Screenshot files MUST have stable, descriptive names, so regenerating them
  replaces the committed files in place instead of adding new ones.

**Documentation**

- **FR-014**: The README MUST show the Dashboard screenshot between the introduction and
  Prerequisites.
- **FR-015**: The Web UI documentation page MUST show the app catalog, job log, Update page, and
  phone-layout screenshots next to the text describing each screen; the Authentik page's OIDC
  section MUST show the Access tab screenshot; and the reverse proxy overview page MUST show
  the proxy driver setting screenshot.
- **FR-016**: Every screenshot reference MUST have alt text that describes what the image
  shows.
- **FR-017**: The documentation MUST explain how to run the demo and how to regenerate the
  screenshots, and `CONTRIBUTING.md` MUST tell contributors to regenerate screenshots after a
  change that alters a screenshotted screen.

**Checks**

- **FR-018**: An automated test MUST confirm the demo inventory passes the same validation the
  real inventory does.
- **FR-019**: An automated test MUST confirm every hostname, domain, IP address, and user in the
  demo data is an example value, so a real value added later fails the test suite.
- **FR-020**: An automated test MUST confirm the demo instance answers the requests each
  screenshotted page makes without an error response.

### Key Entities

- **Demo inventory**: An invented homelab (hosts, guests, subdomains, access tiers, installed
  apps, settings) built from example values only, recreated on every demo start.
- **Seeded job**: A finished job with a fixed timestamp and a short log, present in every demo
  start, so the job pages have content.
- **Screenshot definition**: One entry in the capture set: a file name, the page and any
  interaction needed to reach the screen, the viewport size, and the theme.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader of the README sees the web UI within the first screen of scrolling, and
  at least 7 screenshots appear across the README and documentation pages, each next to the
  text it illustrates.
- **SC-002**: A maintainer regenerates the full screenshot set with one command in under two
  minutes on a typical development machine, with no Proxmox host, Authentik instance, or
  internet connection.
- **SC-003**: A new user goes from a fresh clone to browsing the populated web UI with three
  commands (install, build, demo) and no configuration.
- **SC-004**: No committed screenshot or demo data contains a value outside the constitution's
  example-data table, checked by eye for images and by the test suite for data.
- **SC-005**: The screenshots add no more than 3 MB to the repository in total.

## Assumptions

- Screenshots are PNG files kept in the repository under `docs/images/`, referenced with
  relative links, so they render on GitHub and in a local checkout.
- The capture command is run by hand after UI changes; CI does not run it or check that images
  are current (a stated non-goal of the issue).
- "Supported browser" means an installed Chrome or Edge, or a Chromium installed through the
  browser tool's own explicit install command.
- The phone screenshot uses a 390px-wide viewport, below the web UI's 640px layout breakpoint.
- The demo instance serves the already-built web UI; it does not run the hot-reload development
  server.
- Actions in the demo succeed against simulated responses; the demo does not try to simulate
  the full effect of each action on the example homelab (a preview or a job log is enough).
- The demo's private-LAN addressing (each host's Machine ID scheme) may use documentation-range
  addresses rather than RFC 1918 ones, since nothing in the demo needs a routable private LAN.
- Out of scope: animated GIFs or video, hosting a public live demo, screenshots of the Users and
  Permissions pages, and any CI check that screenshots are up to date.
