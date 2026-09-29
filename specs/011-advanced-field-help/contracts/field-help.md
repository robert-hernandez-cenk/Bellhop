# Contract: Advanced modal field explanations

## Explanation text

`ADVANCED_FIELD_HELP` MUST contain exactly these 15 entries, verbatim. Every value is
at most two sentences, and no value uses an abbreviation containing a period, so a
naive sentence count stays exact.

| Label | Explanation |
|-------|-------------|
| type | Whether this guest is an LXC container (lxc) or a virtual machine (vm), as reported by Proxmox. Update All and package installs never act on a VM. |
| ip | The guest's LAN address, which the proxy forwards this guest's subdomains to. Sync Inventory refreshes it from the guest's Proxmox network config. |
| subdomains | The hostnames the reverse proxy serves for this guest, all forwarding to its ip and port. The first one is canonical and also names the guest's Authentik application when it is gated. |
| host | The Proxmox node this guest runs on; Bellhop reaches the guest through this host over SSH. Move a guest to another host with Migrate Guest, not here. |
| vmid | The guest's Proxmox ID, unique across the whole cluster. Bellhop derives it from the host's machine ID scheme when it creates a guest. |
| port | The port the guest's app listens on, which the proxy forwards to. Left empty, the proxy uses port 80. |
| read-only proxy | The proxy block for this guest is hand-written outside Bellhop's managed section, so Sync Proxy leaves it alone. Authentik gating still applies: its application and group bindings are still kept in sync. |
| insecure backend tls | Lets the proxy reach a backend that serves HTTPS with a self-signed or otherwise untrusted certificate. Set automatically when Bellhop checks the backend's TLS after a subdomain or port change, overriding what is ticked here. |
| auth group | Puts the app behind an Authentik login that members of this group, and of every group above it, can pass. Anyone who can edit this guest may raise it, but only an admin may lower it or remove the gate. |
| auth mode | How the auth group is enforced: forward-auth checks the login at the proxy, while OIDC gives the app its own Authentik login client. Only an admin may change it, and switching away from OIDC deletes that client. |
| callback urls | The addresses Authentik may send a user back to after an OIDC login. No effect unless the guest is gated in OIDC mode, and only an admin may change them. |
| oidc client | The issuer, client ID and client secret the app needs for its OIDC login, read live from Authentik. Only admins can reveal them. |
| unauthenticated paths | Paths that skip the login check, written exactly or ending in /*, such as an API another app calls. No effect unless the guest is gated with forward-auth and read-only proxy is off. |
| vpn | Routes the guest's internet traffic through a VPN gateway guest, or through the LAN gateway when set to none. Changing it starts a job that reboots the guest. |
| app | The community-scripts app this guest was installed from, recorded when Bellhop installed it. The link opens the app's community-scripts page, or its script in your custom script repository. |

## Interaction

`FieldHelp` renders, immediately after the label text:

- a `<button type="button" class="field-help-button">` containing `ⓘ`, with
  `aria-label="About <label>"`, `aria-expanded` = open, and both `aria-controls`
  and `aria-describedby` = the popover's id;
- always, a `<div id=… class="field-help-popover" tabindex="-1">` containing the
  explanation, `hidden` while closed, positioned absolutely under the whole
  `.form-row`. Opening it scrolls it into view (`block: 'nearest'`).

The modal renders each label as `fieldHelp('<label>')`, a local helper typed with
`AdvancedFieldLabel`. The Advanced modal's box (`.modal-box.advanced-modal-box`) has
a viewport-bounded `max-height` and scrolls, so every row and explanation is reachable
on a short phone screen. State transitions are those in [../data-model.md](../data-model.md). The button's
tap target is at least 24×24 CSS px. The popover uses `--bg-secondary`,
`--border`, and `--text-primary`, so it follows the active theme.
