// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// prompt-banner.ts/admin-nav.ts/settings-display.ts. One place for the guest
// Advanced modal's field explanations (issue #34), each at most two
// sentences stating what the field does and anything surprising about it.
// Declared `as const` so AdvancedFieldLabel is the exact key set: the modal's
// fieldHelp('<label>') calls only compile for a real key, and
// test/web-client/advanced-field-help.test.ts also pins that every key is
// rendered exactly once by reading the modal's source. See
// specs/011-advanced-field-help/contracts/field-help.md for the exact text.

export const ADVANCED_FIELD_HELP = {
  type: 'Whether this guest is an LXC container (lxc) or a virtual machine (vm), as reported by Proxmox. Update All and package installs never act on a VM.',
  ip: "The guest's LAN address, which the proxy forwards this guest's subdomains to. Sync Inventory refreshes it from the guest's Proxmox network config.",
  subdomains:
    "The hostnames the reverse proxy serves for this guest, all forwarding to its ip and port. The first one is canonical and also names the guest's Authentik application when it is gated.",
  host: 'The Proxmox node this guest runs on; Bellhop reaches the guest through this host over SSH. Move a guest to another host with Migrate Guest, not here.',
  vmid: "The guest's Proxmox ID, unique across the whole cluster. Bellhop derives it from the host's machine ID scheme when it creates a guest.",
  port: "The port the guest's app listens on, which the proxy forwards to. Left empty, the proxy uses port 80.",
  'read-only proxy':
    "The proxy block for this guest is hand-written outside Bellhop's managed section, so Sync Proxy leaves it alone. Authentik gating still applies: its application and group bindings are still kept in sync.",
  'insecure backend tls':
    "Lets the proxy reach a backend that serves HTTPS with a self-signed or otherwise untrusted certificate. Set automatically when Bellhop checks the backend's TLS after a subdomain or port change, overriding what is ticked here.",
  'auth group':
    'Puts the app behind an Authentik login that members of this group, and of every group above it, can pass. Anyone who can edit this guest may raise it, but only an admin may lower it or remove the gate.',
  'auth mode':
    'How the auth group is enforced: forward-auth checks the login at the proxy, while OIDC gives the app its own Authentik login client. Only an admin may change it, and switching away from OIDC deletes that client.',
  'callback urls':
    'The addresses Authentik may send a user back to after an OIDC login. No effect unless the guest is gated in OIDC mode, and only an admin may change them.',
  'oidc client':
    'The issuer, client ID and client secret the app needs for its OIDC login, read live from Authentik. Only admins can reveal them.',
  'unauthenticated paths':
    'Paths that skip the login check, written exactly or ending in /*, such as an API another app calls. No effect unless the guest is gated with forward-auth and read-only proxy is off.',
  vpn: "Routes the guest's internet traffic through a VPN gateway guest, or through the LAN gateway when set to none. Changing it starts a job that reboots the guest.",
  app: "The community-scripts app this guest was installed from, recorded when Bellhop installed it. The link opens the app's community-scripts page, or its script in your custom script repository.",
} as const;

export type AdvancedFieldLabel = keyof typeof ADVANCED_FIELD_HELP;
