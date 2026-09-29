# Contract: the screenshot set

Seven images under `docs/images/`. File names are stable (FR-013). Desktop is 1440×900 at
device scale 1; phone is 390×844 at device scale 2.

| File | Screen | Viewport | Theme | Placed in |
| --- | --- | --- | --- | --- |
| `dashboard.png` | Dashboard: hosts and guests, statuses, subdomains, auth tiers | desktop | light | `README.md`, between the introduction and Prerequisites |
| `install-app-catalog.png` | Install App form, App field with the catalog suggestion list open | desktop | light | `docs/web-ui.md`, the paragraph on provisioning forms |
| `job-log.png` | Job page for the seeded install-app job, log shown | desktop | dark | `docs/web-ui.md`, the paragraph on live job logs |
| `update-page.png` | Update page, per-host/guest cards with update icons | desktop | light | `docs/web-ui.md`, the paragraph on `/update` |
| `dashboard-phone.png` | Dashboard in the phone card layout | phone | light | `docs/web-ui.md`, a short new paragraph on the phone layout |
| `guest-access-oidc.png` | Advanced modal, Access tab, for the demo's OIDC guest (element capture of the modal) | desktop | light | `docs/authentik.md`, OIDC mode section |
| `settings-proxy-driver.png` | Settings page, proxy driver setting area | desktop | light | `docs/reverse-proxy/README.md`, where choosing a driver is described |

Every reference uses a relative Markdown image link with alt text describing what is shown, for
example `![Bellhop Dashboard listing two Proxmox hosts and their guests, with status, subdomains and access tier for each](docs/images/dashboard.png)`.

A shot's ready selector and preparation steps are implementation details of
`scripts/screenshots.ts`; they must key on visible text or accessible names where possible, so
a styling change does not break capture.
