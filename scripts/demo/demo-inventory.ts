// Builds the example-only Inventory the demo web UI (scripts/demo/serve.ts)
// and the screenshot capture script (scripts/capture-screenshots.ts) run
// against. Every value here follows the constitution's Example Data
// Conventions (docs/../.specify/memory/constitution.md): RFC 5737 IPv4
// ranges, example.com, and generic host/guest names -- never real
// operational data. See specs/014-web-ui-screenshots/data-model.md for the
// exact shape this is built to.
//
// buildDemoInventory() returns a brand-new object graph on every call (no
// shared array/object references between calls) so that one demo run's
// in-memory edits, or a test mutating its own copy, can never leak into a
// later call.
import type { Inventory } from '../../src/lib/inventory.ts';
import type { SecretSettingKey } from '../../src/lib/settings-defs.ts';

// Example secrets the demo stores in the "set" state (issue #64, FR-027),
// so the Settings page shows its write-only secret fields as they look on
// a configured deployment. Obviously fake on purpose. The Authentik API
// token is deliberately absent: the demo injects an unconfigured Authentik
// client, and a stored token plus URL would make authentikConfigured() true
// while that client still says otherwise. Kept apart from
// buildDemoInventory() because a secret is never part of an Inventory.
export const DEMO_SECRET_SETTINGS: Readonly<Partial<Record<SecretSettingKey, string>>> = {
  cloudflareDnsApiToken: 'demo-example-cloudflare-token',
  npmApiPassword: 'demo-example-password',
  githubApiToken: 'demo-example-github-token',
  webUiOidcClientSecret: 'demo-example-client-secret',
};

export function buildDemoInventory(): Inventory {
  return {
    domain: 'example.com',
    backupStorage: 'nas-backup',
    dnsServer: '198.51.100.53',
    // Not 198.51.100.5 -- that address belongs to the paperless-ngx guest
    // below; a free address in the same range keeps the two from colliding.
    nfsServer: '198.51.100.50',
    // Stored rather than set through WEB_UI_AUTH_MODE (issue #64): the demo
    // signs every request in with a seeded admin session (#69), the same
    // way a production deployment does with this setting stored. The four
    // OIDC values are examples so the Settings General tab shows a
    // configured web login; nothing ever contacts this issuer.
    webUiAuthMode: 'oidc',
    webUiOidcIssuer: 'https://authentik.example.com/application/o/bellhop/',
    webUiOidcClientId: 'example-client-id',
    webUiOidcRedirectUri: 'https://bellhop.example.com/auth/callback',
    // Two moved Authentik settings, so that Settings tab isn't all
    // placeholders. Both are the stock defaults.
    authentikOutpostName: 'authentik Embedded Outpost',
    authentikOutpostPort: '9000',
    hosts: [
      {
        name: 'pve1',
        ssh_target: '192.0.2.11',
        ssh_user: 'root',
        midScheme: {
          vmidBase: 1000,
          ipPrefix: '198.51.100.',
          gateway: '198.51.100.1',
        },
        bridges: [
          { name: 'vmbr0', alias: 'LAN', active: true },
          { name: 'vmbr1', alias: 'Guest LAN', active: true },
        ],
        storages: [
          { name: 'local', type: 'dir', content: ['vztmpl', 'iso'], active: true },
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-backup', type: 'nfs', content: ['backup'], active: true },
        ],
      },
      {
        name: 'pve2',
        ssh_target: '192.0.2.12',
        ssh_user: 'root',
        midScheme: {
          vmidBase: 2000,
          ipPrefix: '203.0.113.',
          gateway: '203.0.113.1',
        },
        bridges: [{ name: 'vmbr0', alias: 'LAN', active: true }],
        storages: [
          { name: 'local', type: 'dir', content: ['vztmpl', 'iso'], active: true },
          { name: 'local-zfs', type: 'zfspool', content: ['rootdir', 'images'], active: true },
        ],
      },
    ],
    guests: [
      // The reverse proxy itself.
      {
        name: 'proxy',
        type: 'lxc',
        vmid: 1001,
        host: 'pve1',
        // Not 198.51.100.1 -- that's pve1's own midScheme.gateway.
        ip: '198.51.100.10',
        proxy: true,
        app: 'caddy',
      },
      // The Authentik instance.
      {
        name: 'auth',
        type: 'lxc',
        vmid: 1002,
        host: 'pve1',
        ip: '198.51.100.2',
        authentik: true,
        subdomains: ['auth.example.com'],
        port: 9000,
        app: 'authentik',
      },
      // Media apps, forward-auth-gated at two different ladder rungs, one
      // with more than one subdomain and one with an unauthenticatedPaths
      // exemption for its own API callers.
      {
        name: 'jellyfin',
        type: 'lxc',
        vmid: 1003,
        host: 'pve1',
        ip: '198.51.100.3',
        subdomains: ['jellyfin.example.com', 'media.example.com'],
        port: 8096,
        authGroup: 'bellhop-public',
        app: 'jellyfin',
      },
      {
        name: 'homeassistant',
        type: 'lxc',
        vmid: 1004,
        host: 'pve1',
        ip: '198.51.100.4',
        subdomains: ['home.example.com'],
        port: 8123,
        authGroup: 'bellhop-admin-family',
        app: 'homeassistant',
      },
      {
        name: 'paperless-ngx',
        type: 'lxc',
        vmid: 1005,
        host: 'pve1',
        ip: '198.51.100.5',
        subdomains: ['docs.example.com'],
        port: 8000,
        authGroup: 'bellhop-admin-family',
        unauthenticatedPaths: ['/api/*'],
        app: 'paperless-ngx',
      },
      {
        name: 'nextcloud',
        type: 'lxc',
        vmid: 1006,
        host: 'pve1',
        ip: '198.51.100.6',
        subdomains: ['cloud.example.com'],
        port: 443,
        insecureBackendTls: true,
        app: 'nextcloud',
      },
      // The one OIDC-gated guest -- its own Authentik OpenID client rather
      // than forward-auth, per data-model.md.
      {
        name: 'vaultwarden',
        type: 'lxc',
        vmid: 1007,
        host: 'pve1',
        ip: '198.51.100.7',
        subdomains: ['vault.example.com'],
        port: 8080,
        authGroup: 'bellhop-friends-family',
        authMode: 'oidc',
        oidcRedirectUris: ['https://vault.example.com/oidc/callback'],
        app: 'vaultwarden',
      },
      // A second host's guests, including the one VM.
      {
        name: 'grafana',
        type: 'lxc',
        vmid: 2001,
        host: 'pve2',
        // Not 203.0.113.1 -- that's pve2's own midScheme.gateway.
        ip: '203.0.113.10',
        subdomains: ['grafana.example.com'],
        port: 3000,
        authGroup: 'bellhop-public',
        app: 'grafana',
        // The one demo guest with a recorded creator (issue #58), showing the
        // Advanced modal's read-only "Created by" row.
        creator: { username: 'test-user' },
      },
      {
        name: 'pihole',
        type: 'lxc',
        vmid: 2002,
        host: 'pve2',
        ip: '203.0.113.2',
        app: 'pihole',
      },
      {
        name: 'demo-vm',
        type: 'vm',
        vmid: 2003,
        host: 'pve2',
        ip: '203.0.113.3',
      },
    ],
  };
}
