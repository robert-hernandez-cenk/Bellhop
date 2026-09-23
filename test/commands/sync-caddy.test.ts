import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runSyncCaddy, buildCaddyBlock } from '../../src/commands/networking/sync-caddy.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', port: 8080, subdomains: ['media', 'movies'] },
    { name: 'other', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.168.1.60', subdomains: ['other'] },
    { name: 'no-subdomain', type: 'lxc', vmid: 107, host: 'pve1' },
  ],
};

const TLS_LINES = '\\n {4}tls \\{\\n {8}dns cloudflare \\{env\\.CLOUDFLARE_API_TOKEN\\}\\n {8}resolvers 1\\.1\\.1\\.1 8\\.8\\.8\\.8\\n {4}\\}';

test('buildCaddyBlock combines an entry\'s subdomains into one comma-separated address list, with TLS on every block', () => {
  const block = buildCaddyBlock(inventory);
  assert.match(
    block,
    new RegExp(
      `^media\\.example\\.com, movies\\.example\\.com \\{\\n {4}reverse_proxy 192\\.168\\.1\\.50:8080 \\{\\n {8}header_up X-Forwarded-Port 443\\n {4}\\}${TLS_LINES}\\n\\}$`,
      'm'
    )
  );
  assert.match(
    block,
    new RegExp(
      `^other\\.example\\.com \\{\\n {4}reverse_proxy 192\\.168\\.1\\.60:80 \\{\\n {8}header_up X-Forwarded-Port 443\\n {4}\\}${TLS_LINES}\\n\\}$`,
      'm'
    )
  );
  assert.doesNotMatch(block, /no-subdomain/);
  assert.match(block, /^# BEGIN bellhop-managed/);
  assert.match(block, /# END bellhop-managed$/);
});

test('buildCaddyBlock adds a tls_insecure_skip_verify transport when insecureBackendTls is set, alongside header_up', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true },
      {
        name: 'pve2',
        ssh_target: '192.168.1.253',
        ssh_user: 'root',
        ip: '192.168.1.253',
        port: 8006,
        subdomains: ['proxmox'],
        insecureBackendTls: true,
      },
    ],
    guests: [],
  };
  const block = buildCaddyBlock(inv);
  assert.match(
    block,
    /proxmox\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.253:8006 \{\n {8}header_up X-Forwarded-Port 443\n {8}transport http \{\n {12}tls_insecure_skip_verify\n {8}\}\n {4}\}\n {4}tls \{/
  );
});

test('buildCaddyBlock includes externalSites entries alongside hosts/guests', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [],
    externalSites: [{ name: 'nas', ip: '192.168.1.250', port: 5001, subdomains: ['nas'], insecureBackendTls: true }],
  };
  const block = buildCaddyBlock(inv);
  assert.match(
    block,
    /nas\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.250:5001 \{\n {8}header_up X-Forwarded-Port 443\n {8}transport http \{/
  );
});

test('buildCaddyBlock skips an entry with caddyManual set, even though it has subdomains', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      {
        name: 'caddy-lxc',
        type: 'lxc',
        vmid: 4002,
        host: 'pve1',
        ip: '192.168.1.2',
        subdomains: ['caddy'],
        caddyManual: true,
      },
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['media'] },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.doesNotMatch(block, /caddy\.example\.com/);
  assert.match(block, /media\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.50:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}/);
});

test('runSyncCaddy throws when no entry has caddy: true', async () => {
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runSyncCaddy({}, { ssh, inventory: noCaddy }), /No inventory entry has 'caddy: true'/);
});

test('runSyncCaddy does not call ssh when apply is not set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncCaddy({}, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(ssh.history.length, 0);
});

test('runSyncCaddy writes the managed block on the caddy host when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncCaddy({ apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  assert.match(ssh.history[0].command, /caddy validate --adapter caddyfile/);
  assert.match(ssh.history[0].command, /systemctl reload caddy/);
});

test('buildCaddyBlock adds a forward_auth directive and outpost passthrough when authGroup is set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'homelab-users' },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.match(
    block,
    /sonarr\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.20:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}\n {4}forward_auth 192\.168\.1\.5:9000 \{\n {8}uri \/outpost\.goauthentik\.io\/auth\/caddy\n {8}copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid\n {4}\}\n {4}handle \/outpost\.goauthentik\.io\/\* \{\n {8}reverse_proxy 192\.168\.1\.5:9000\n {4}\}\n {4}tls \{/
  );
});

test('buildCaddyBlock wraps forward_auth in a not-path matcher when unauthenticatedPaths is set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'whisparr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['whisparr'],
        authGroup: 'homelab-users',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.match(
    block,
    /whisparr\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.21:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}\n {4}@auth_required \{\n {8}not path \/api\/\*\n {4}\}\n {4}forward_auth @auth_required 192\.168\.1\.5:9000 \{\n {8}uri \/outpost\.goauthentik\.io\/auth\/caddy\n {8}copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid\n {4}\}\n {4}handle \/outpost\.goauthentik\.io\/\* \{\n {8}reverse_proxy 192\.168\.1\.5:9000\n {4}\}\n {4}tls \{/
  );
});

test('buildCaddyBlock joins multiple unauthenticatedPaths into one space-separated not-path matcher', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'whisparr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['whisparr'],
        authGroup: 'homelab-users',
        unauthenticatedPaths: ['/api/*', '/system/*'],
      },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.match(block, /not path \/api\/\* \/system\/\*/);
});

test('buildCaddyBlock leaves forward_auth unmatched when unauthenticatedPaths is unset (unchanged from today)', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'homelab-users' },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.doesNotMatch(block, /@auth_required/);
  assert.match(block, /forward_auth 192\.168\.1\.5:9000 \{/);
});

test('buildCaddyBlock ignores unauthenticatedPaths on an entry with authGroup unset', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['media'], unauthenticatedPaths: ['/api/*'] },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.doesNotMatch(block, /@auth_required/);
  assert.doesNotMatch(block, /forward_auth/);
});

test('buildCaddyBlock skips an entry with caddyManual set, even though it has authGroup and unauthenticatedPaths', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'caddy-lxc',
        type: 'lxc',
        vmid: 4002,
        host: 'pve1',
        ip: '192.168.1.2',
        subdomains: ['caddy'],
        caddyManual: true,
        authGroup: 'homelab-users',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const block = buildCaddyBlock(inv);
  assert.doesNotMatch(block, /caddy\.example\.com/);
  assert.doesNotMatch(block, /@auth_required/);
  assert.doesNotMatch(block, /forward_auth/);
});

test('buildCaddyBlock throws when an authGroup entry exists but no authentik:true entry has an ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'homelab-users' },
    ],
  };
  assert.throws(() => buildCaddyBlock(inv), /'sonarr' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set/);
});

test('sync-caddy emits the configured Authentik outpost port', async () => {
  const original = process.env.AUTHENTIK_OUTPOST_PORT;
  process.env.AUTHENTIK_OUTPOST_PORT = '9100';
  try {
    const inventory: Inventory = {
      domain: 'example.com',
      hosts: [
        { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true },
        { name: 'auth-lxc-host', ssh_target: 'pve2.local', ssh_user: 'root', authentik: true, ip: '192.168.1.9' },
      ],
      guests: [
        { name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', port: 32400, subdomains: ['plex'], authGroup: 'homelab-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const result = await runSyncCaddy({}, { ssh, inventory });
    assert.match(result.block, /forward_auth 192\.168\.1\.9:9100/);
    assert.doesNotMatch(result.block, /:9000/);
  } finally {
    if (original === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = original;
  }
});
