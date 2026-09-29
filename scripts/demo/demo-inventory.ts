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

export function buildDemoInventory(): Inventory {
  return {
    domain: 'example.com',
    backupStorage: 'nas-backup',
    dnsServer: '198.51.100.53',
    nfsServer: '198.51.100.5',
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
        ip: '198.51.100.1',
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
        authGroup: 'bellhop-app-users-open',
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
        authGroup: 'bellhop-users',
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
        authGroup: 'bellhop-users',
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
        authGroup: 'bellhop-app-users',
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
        ip: '203.0.113.1',
        subdomains: ['grafana.example.com'],
        port: 3000,
        authGroup: 'bellhop-app-users-open',
        app: 'grafana',
      },
      {
        name: 'pihole',
        type: 'lxc',
        vmid: 2002,
        host: 'pve2',
        ip: '203.0.113.2',
        app: 'pi-hole',
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
