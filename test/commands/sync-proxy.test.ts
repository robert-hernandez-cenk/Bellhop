import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runSyncProxy } from '../../src/commands/networking/sync-proxy.ts';
import { registerDriverForTests } from '../../src/lib/proxy/index.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../src/lib/proxy/driver.ts';
import { NO_PROXY_SYNC_MESSAGE } from '../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../src/lib/proxy/ids.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { createNpmDriver } from '../../src/lib/proxy/drivers/nginx-proxy-manager.ts';
import { FakeNpmClient } from '../support/fake-npm-client.ts';

// A driver that declares no forward-auth support -- exercises T034/FR-011's
// refusal path. `id` is cast through ProxyDriverId since PROXY_DRIVER_IDS
// only lists the shipped ids (src/lib/proxy/ids.ts); same convention as
// test/lib/proxy/{driver,index}.test.ts's own fakeDriver.
function oidcOnlyDriver(): ReverseProxyDriver {
  return {
    id: 'fake-oidc-only' as ProxyDriverId,
    label: 'Fake',
    capabilities: { authModes: ['oidc'], acmeDns01ViaCloudflare: () => false },
    defaultConfigPath: '/etc/fake/fake.conf',
    statusPage: null,
    async plan(): Promise<ProxyPlan> {
      return { preview: '', payload: undefined };
    },
    async apply(): Promise<void> {},
    async snapshot(): Promise<string> {
      return '';
    },
  };
}

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', port: 8080, subdomains: ['media', 'movies'] },
    { name: 'other', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.168.1.60', subdomains: ['other'] },
    { name: 'no-subdomain', type: 'lxc', vmid: 107, host: 'pve1' },
  ],
};

const TLS_LINES = '\\n {4}tls \\{\\n {8}dns cloudflare \\{env\\.CLOUDFLARE_API_TOKEN\\}\\n {8}resolvers 1\\.1\\.1\\.1 8\\.8\\.8\\.8\\n {4}\\}';

// runSyncProxy is orchestration over the driver registry, so these tests
// drive the whole pipeline in dry-run mode (apply not set, so no ssh call
// happens) and read the generated configuration off result.preview.
async function buildBlock(inv: Inventory): Promise<string> {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: inv });
  return result.preview;
}

test('sync-proxy (caddy driver) combines an entry\'s subdomains into one comma-separated address list, with TLS on every block', async () => {
  const block = await buildBlock(inventory);
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

test('sync-proxy (caddy driver) adds a tls_insecure_skip_verify transport when insecureBackendTls is set, alongside header_up', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true },
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
  const block = await buildBlock(inv);
  assert.match(
    block,
    /proxmox\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.253:8006 \{\n {8}header_up X-Forwarded-Port 443\n {8}transport http \{\n {12}tls_insecure_skip_verify\n {8}\}\n {4}\}\n {4}tls \{/
  );
});

test('sync-proxy (caddy driver) includes externalSites entries alongside hosts/guests', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
    externalSites: [{ name: 'nas', ip: '192.168.1.250', port: 5001, subdomains: ['nas'], insecureBackendTls: true }],
  };
  const block = await buildBlock(inv);
  assert.match(
    block,
    /nas\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.250:5001 \{\n {8}header_up X-Forwarded-Port 443\n {8}transport http \{/
  );
});

test('sync-proxy (caddy driver) skips an entry with proxyManual set, even though it has subdomains', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'caddy-lxc',
        type: 'lxc',
        vmid: 4002,
        host: 'pve1',
        ip: '192.168.1.2',
        subdomains: ['caddy'],
        proxyManual: true,
      },
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['media'] },
    ],
  };
  const block = await buildBlock(inv);
  assert.doesNotMatch(block, /caddy\.example\.com/);
  assert.match(block, /media\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.50:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}/);
});

test('runSyncProxy throws when no entry has proxy: true', async () => {
  const noProxy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runSyncProxy({}, { ssh, inventory: noProxy }), /No inventory entry has 'proxy: true'/);
});

test('runSyncProxy returns { proxyHost, driver, preview, applied }', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory });
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'driver', 'preview', 'proxyHost']);
  assert.equal(result.proxyHost, 'pve1');
  assert.equal(result.driver, 'caddy');
  assert.match(result.preview, /^# BEGIN bellhop-managed/);
  assert.equal(result.applied, false);
});

test('runSyncProxy writes to the proxyConfigPath setting when set, else the driver default', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runSyncProxy({ apply: true }, { ssh, inventory: { ...inventory, proxyConfigPath: '/opt/proxy/Caddyfile' } });
  assert.match(ssh.history[0].command, /'\/opt\/proxy\/Caddyfile'/);
  assert.doesNotMatch(ssh.history[0].command, /\/etc\/caddy\/Caddyfile/);

  const ssh2 = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runSyncProxy({ apply: true }, { ssh: ssh2, inventory });
  assert.match(ssh2.history[0].command, /'\/etc\/caddy\/Caddyfile'/);
});

test('runSyncProxy does not call ssh when apply is not set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(ssh.history.length, 0);
});

test('runSyncProxy writes the managed block on the proxy host when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({ apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  assert.match(ssh.history[0].command, /caddy validate --adapter caddyfile/);
  assert.match(ssh.history[0].command, /systemctl reload caddy/);
});

test('runSyncProxy rejects, naming the stderr, when the remote apply script exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'caddy validate failed; restored previous configuration', code: 1 }));
  await assert.rejects(
    () => runSyncProxy({ apply: true }, { ssh, inventory }),
    /Failed to apply proxy configuration on 'pve1': caddy validate failed; restored previous configuration/
  );
});

test('sync-proxy (caddy driver) adds a forward_auth directive and outpost passthrough when authGroup is set', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const block = await buildBlock(inv);
  assert.match(
    block,
    /sonarr\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.20:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}\n {4}forward_auth 192\.168\.1\.5:9000 \{\n {8}uri \/outpost\.goauthentik\.io\/auth\/caddy\n {8}copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid\n {4}\}\n {4}handle \/outpost\.goauthentik\.io\/\* \{\n {8}reverse_proxy 192\.168\.1\.5:9000\n {4}\}\n {4}tls \{/
  );
});

test('sync-proxy (caddy driver) wraps forward_auth in a not-path matcher when unauthenticatedPaths is set', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'whisparr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['whisparr'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const block = await buildBlock(inv);
  assert.match(
    block,
    /whisparr\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.21:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}\n {4}@auth_required \{\n {8}not path \/api\/\*\n {4}\}\n {4}forward_auth @auth_required 192\.168\.1\.5:9000 \{\n {8}uri \/outpost\.goauthentik\.io\/auth\/caddy\n {8}copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid\n {4}\}\n {4}handle \/outpost\.goauthentik\.io\/\* \{\n {8}reverse_proxy 192\.168\.1\.5:9000\n {4}\}\n {4}tls \{/
  );
});

test('sync-proxy (caddy driver) joins multiple unauthenticatedPaths into one space-separated not-path matcher', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'whisparr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['whisparr'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/api/*', '/system/*'],
      },
    ],
  };
  const block = await buildBlock(inv);
  assert.match(block, /not path \/api\/\* \/system\/\*/);
});

test('sync-proxy (caddy driver) leaves forward_auth unmatched when unauthenticatedPaths is unset (unchanged from today)', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const block = await buildBlock(inv);
  assert.doesNotMatch(block, /@auth_required/);
  assert.match(block, /forward_auth 192\.168\.1\.5:9000 \{/);
});

test('sync-proxy (caddy driver) ignores unauthenticatedPaths on an entry with authGroup unset', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['media'], unauthenticatedPaths: ['/api/*'] },
    ],
  };
  const block = await buildBlock(inv);
  assert.doesNotMatch(block, /@auth_required/);
  assert.doesNotMatch(block, /forward_auth/);
});

test('sync-proxy (caddy driver) skips an entry with proxyManual set, even though it has authGroup and unauthenticatedPaths', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      {
        name: 'caddy-lxc',
        type: 'lxc',
        vmid: 4002,
        host: 'pve1',
        ip: '192.168.1.2',
        subdomains: ['caddy'],
        proxyManual: true,
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const block = await buildBlock(inv);
  assert.doesNotMatch(block, /caddy\.example\.com/);
  assert.doesNotMatch(block, /@auth_required/);
  assert.doesNotMatch(block, /forward_auth/);
});

test('sync-proxy (caddy driver) throws when an authGroup entry exists but no authentik:true entry has an ip', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  await assert.rejects(
    () => buildBlock(inv),
    /'sonarr' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set/
  );
});

test('sync-proxy (caddy driver) emits a plain reverse proxy for an OIDC-mode entry, with no forward_auth/outpost/matcher even with unauthenticatedPaths set', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'whisparr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['whisparr'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const block = await buildBlock(inv);
  assert.match(
    block,
    /whisparr\.example\.com \{\n {4}reverse_proxy 192\.168\.1\.21:80 \{\n {8}header_up X-Forwarded-Port 443\n {4}\}\n {4}tls \{/
  );
  assert.doesNotMatch(block, /forward_auth/);
  assert.doesNotMatch(block, /outpost\.goauthentik\.io/);
  assert.doesNotMatch(block, /@auth_required/);
});

test('sync-proxy (caddy driver) does not require an authentik: true entry when the only gated entry is OIDC-mode', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.168.1.20',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
      },
    ],
  };
  await buildBlock(inv);
});

test('runSyncProxy refuses (dry run) with the capability message, and makes zero SSH calls, when the active driver cannot enforce a forward-gated entry (FR-011)', async () => {
  const driver = oidcOnlyDriver();
  const unregister = registerDriverForTests(driver);
  try {
    const inv: Inventory = {
      domain: 'example.com',
      proxyDriver: driver.id,
      hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
      guests: [
        { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
        { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    await assert.rejects(
      () => runSyncProxy({}, { ssh, inventory: inv }),
      /Entry 'sonarr' uses forward-auth gating, but the 'fake-oidc-only' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup/
    );
    assert.equal(ssh.history.length, 0);
  } finally {
    unregister();
  }
});

test('runSyncProxy refuses (apply) the same way, before writing anything, with zero SSH calls', async () => {
  const driver = oidcOnlyDriver();
  const unregister = registerDriverForTests(driver);
  try {
    const inv: Inventory = {
      domain: 'example.com',
      proxyDriver: driver.id,
      hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
      guests: [
        { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
        { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    await assert.rejects(
      () => runSyncProxy({ apply: true }, { ssh, inventory: inv }),
      /Entry 'sonarr' uses forward-auth gating, but the 'fake-oidc-only' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup/
    );
    assert.equal(ssh.history.length, 0);
  } finally {
    unregister();
  }
});

test('runSyncProxy joins every offending entry\'s message into one thrown Error', async () => {
  const driver = oidcOnlyDriver();
  const unregister = registerDriverForTests(driver);
  try {
    const inv: Inventory = {
      domain: 'example.com',
      proxyDriver: driver.id,
      hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
      guests: [
        { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
        { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
        { name: 'radarr', type: 'lxc', vmid: 121, host: 'pve1', ip: '192.168.1.21', subdomains: ['radarr'], authGroup: 'bellhop-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    let thrown: unknown;
    try {
      await runSyncProxy({}, { ssh, inventory: inv });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'expected runSyncProxy to throw');
    assert.match((thrown as Error).message, /'sonarr'/);
    assert.match((thrown as Error).message, /'radarr'/);
    assert.equal(ssh.history.length, 0);
  } finally {
    unregister();
  }
});

// --- nginx driver (issue #30, US1) ------------------------------------------

test('sync-proxy (nginx driver) dry run returns driver "nginx" and a preview starting with the generated header', async () => {
  const inv: Inventory = { ...inventory, proxyDriver: 'nginx' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: inv });
  assert.equal(result.driver, 'nginx');
  assert.match(result.preview, /^# Generated by Bellhop sync-proxy\. Do not edit: this file is replaced on every apply\./);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (nginx driver) --apply writes the owned conf file via "cat >", validates with "nginx -t", and ends with the reload', async () => {
  const inv: Inventory = { ...inventory, proxyDriver: 'nginx' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({ apply: true }, { ssh, inventory: inv });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  assert.match(ssh.history[0].command, /cat > '\/etc\/nginx\/conf\.d\/bellhop\.conf' <</, 'writes the owned file whole via cat >');
  assert.match(ssh.history[0].command, /if ! nginx -t; then/, 'validates with nginx -t');
  assert.match(ssh.history[0].command, /systemctl reload nginx$/m, 'ends with the reload command');
});

// --- HAProxy driver (issue #32, US1) -----------------------------------------
//
// The contract example (specs/015-haproxy-proxy-driver/contracts/
// haproxy-config.md "Example"): an insecureBackendTls host on 8006 that is
// also the proxy host, an ungated guest with two hostnames, and an
// OIDC-gated external site on 443.
const haproxyInventory: Inventory = {
  domain: 'example.com',
  proxyDriver: 'haproxy',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      proxy: true,
      ip: '192.0.2.2',
      port: 8006,
      subdomains: ['pve'],
      insecureBackendTls: true,
    },
  ],
  guests: [{ name: 'web-lxc', type: 'lxc', vmid: 100, host: 'pve1', ip: '192.0.2.10', port: 8080, subdomains: ['web', 'www'] }],
  externalSites: [
    { name: 'nas', ip: '192.0.2.20', port: 443, subdomains: ['nas'], authGroup: 'bellhop-users', authMode: 'oidc' },
  ],
};

const HAPROXY_HEADER = '# Generated by Bellhop sync-proxy for HAProxy. Do not edit: this file is replaced on every apply.';

function haproxyBackend(name: string, serverLine: string): string[] {
  return [
    `backend ${name}`,
    '    mode http',
    '    timeout server 1d',
    '    timeout tunnel 1d',
    '    http-request del-header x-authentik- -m beg',
    '    http-request set-header X-Forwarded-For %[src]',
    '    http-request set-header X-Forwarded-Proto https',
    '    http-request set-header X-Forwarded-Host %[req.hdr(host)]',
    '    http-request set-header X-Forwarded-Port 443',
    serverLine,
  ];
}

test('sync-proxy (haproxy driver) dry run returns the contract preview -- backends file then map file -- and makes no SSH call', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: haproxyInventory });
  const expected = [
    '==> /etc/haproxy/bellhop.cfg <==',
    HAPROXY_HEADER,
    '',
    ...haproxyBackend('bellhop_host_pve1', '    server app 192.0.2.2:8006 ssl verify none'),
    '',
    ...haproxyBackend('bellhop_guest_web-lxc', '    server app 192.0.2.10:8080'),
    '',
    ...haproxyBackend(
      'bellhop_externalSite_nas',
      '    server app 192.0.2.20:443 ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt'
    ),
    '',
    '==> /etc/haproxy/bellhop.map <==',
    HAPROXY_HEADER,
    'pve.example.com bellhop_host_pve1',
    'web.example.com bellhop_guest_web-lxc',
    'www.example.com bellhop_guest_web-lxc',
    'nas.example.com bellhop_externalSite_nas',
  ].join('\n');
  assert.equal(result.driver, 'haproxy');
  assert.equal(result.proxyHost, 'pve1');
  assert.equal(result.applied, false);
  assert.equal(result.preview, expected);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (haproxy driver) --apply sends one script to the proxy host writing both files, validating, then reloading', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({ apply: true }, { ssh, inventory: haproxyInventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  const script = ssh.history[0].command;
  assert.match(script, /cat > '\/etc\/haproxy\/bellhop\.cfg' <</);
  assert.match(script, /cat > '\/etc\/haproxy\/bellhop\.map' <</);
  assert.ok(script.includes("if ! haproxy -c -f /etc/haproxy/haproxy.cfg -f '/etc/haproxy/bellhop.cfg'; then"));
  assert.match(script, /systemctl reload haproxy$/m);
});

// --- HAProxy driver (issue #32, US2) -- forward-gated entries refused ------
//
// The real, registered 'haproxy' driver (capabilities: oidc only) -- no fake
// driver needed. checkCapabilities runs after buildRoutes, so a forward-
// gated route that would actually get derived needs an authentik:true entry
// with an ip, or buildRoutes throws its own missing-authentik error first.

const HAPROXY_FORWARD_REFUSAL =
  "Entry 'sonarr' uses forward-auth gating, but the 'haproxy' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup";

const haproxyForwardGatedInventory: Inventory = {
  domain: 'example.com',
  proxyDriver: 'haproxy',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [
    { name: 'auth-lxc', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
    { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
  ],
};

test('sync-proxy (haproxy driver) refuses a forward-gated guest with subdomains (dry run) with exactly the capability message, and makes no SSH call', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  let thrown: unknown;
  try {
    await runSyncProxy({}, { ssh, inventory: haproxyForwardGatedInventory });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, 'expected runSyncProxy to throw');
  assert.equal((thrown as Error).message, HAPROXY_FORWARD_REFUSAL);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (haproxy driver) refuses the same forward-gated guest on --apply, before writing anything, with no SSH call', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  let thrown: unknown;
  try {
    await runSyncProxy({ apply: true }, { ssh, inventory: haproxyForwardGatedInventory });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, 'expected runSyncProxy to throw');
  assert.equal((thrown as Error).message, HAPROXY_FORWARD_REFUSAL);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (haproxy driver) refuses a forward-gated guest with the capability message even when no authentik entry exists -- not the missing-outpost error', async () => {
  const inv: Inventory = {
    ...haproxyForwardGatedInventory,
    guests: haproxyForwardGatedInventory.guests.filter((g) => !g.authentik),
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  let thrown: unknown;
  try {
    await runSyncProxy({}, { ssh, inventory: inv });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, 'expected runSyncProxy to throw');
  assert.equal((thrown as Error).message, HAPROXY_FORWARD_REFUSAL);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (haproxy driver) does not refuse a forward-gated proxyManual entry -- buildRoutes never derives a route for it', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    proxyDriver: 'haproxy',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'caddy-lxc',
        type: 'lxc',
        vmid: 4002,
        host: 'pve1',
        ip: '192.168.1.2',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
        proxyManual: true,
      },
    ],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: inv });
  assert.equal(result.driver, 'haproxy');
  assert.doesNotMatch(result.preview, /sonarr/);
  assert.equal(ssh.history.length, 0);
});

test('sync-proxy (haproxy driver) does not refuse a forward-gated entry with no subdomains -- no route is derived at all', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    proxyDriver: 'haproxy',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', authGroup: 'bellhop-users' }],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: inv });
  assert.equal(result.driver, 'haproxy');
  assert.equal(ssh.history.length, 0);
});

// --- Nginx Proxy Manager driver (issue #31, US1) -----------------------------
//
// The real nginxProxyManagerDriver builds its client from the environment,
// so these tests register a createNpmDriver instance around a FakeNpmClient
// under a test-only id -- spread rather than mutated, since the driver's
// methods close over their client and never read `this`.
function registerFakeNpm(client: FakeNpmClient): { id: ProxyDriverId; unregister: () => void } {
  const driver: ReverseProxyDriver = { ...createNpmDriver({ clientFor: () => client }), id: 'fake-npm' as ProxyDriverId };
  return { id: driver.id, unregister: registerDriverForTests(driver) };
}

test('sync-proxy (Nginx Proxy Manager driver) dry run returns its preview, applied: false, and writes nothing -- with configPath null', async () => {
  const client = new FakeNpmClient();
  const { id, unregister } = registerFakeNpm(client);
  try {
    const inv: Inventory = { ...inventory, proxyDriver: id, proxyConfigPath: '/etc/caddy/Caddyfile' };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const result = await runSyncProxy({}, { ssh, inventory: inv });
    assert.equal(result.proxyHost, 'pve1');
    assert.equal(result.driver, id);
    assert.equal(result.applied, false);
    assert.match(result.preview, /^Nginx Proxy Manager at http:\/\/192\.0\.2\.30:81\n/);
    assert.match(result.preview, /\+ create {2}media\.example\.com, movies\.example\.com -> http:\/\/192\.168\.1\.50:8080/);
    assert.deepEqual(client.writes(), []);
    assert.equal(ssh.history.length, 0, 'the NPM driver never uses SSH');
  } finally {
    unregister();
  }
});

test('sync-proxy (Nginx Proxy Manager driver) --apply creates the proxy hosts and returns applied: true', async () => {
  const client = new FakeNpmClient();
  const { id, unregister } = registerFakeNpm(client);
  try {
    const inv: Inventory = { ...inventory, proxyDriver: id };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const result = await runSyncProxy({ apply: true }, { ssh, inventory: inv });
    assert.equal(result.applied, true);
    assert.deepEqual(
      [...client.hosts.values()].map((h) => h.domain_names),
      [['media.example.com', 'movies.example.com'], ['other.example.com']]
    );
    assert.equal(ssh.history.length, 0);
  } finally {
    unregister();
  }
});

// Issue #33 US2: under proxyDriver: 'none', runSyncProxy must short-circuit
// before driverDeps()/buildRoutes()/checkCapabilities() ever run -- so this
// inventory deliberately has no 'proxy: true' entry and a forward-gated
// entry ('sonarr') with no 'authentik: true' entry, either of which would
// throw under the real caddy driver (see the 'No inventory entry has
// proxy: true' and 'has an authGroup set but no...authentik' tests above).
// Reaching a clean { proxyHost: null, ... } result here proves the
// short-circuit happens first.
const noProxyInventory: Inventory = {
  domain: 'example.com',
  proxyDriver: 'none',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
  ],
};

test("runSyncProxy (dry run) returns { proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE } and makes no SSH calls", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: noProxyInventory });
  assert.deepEqual(result, { proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE, applied: false });
  assert.equal(ssh.history.length, 0);
});

// applied stays false even with --apply: nothing is ever written under
// 'none', so reporting true would claim a write that never happened.
test("runSyncProxy (apply) returns the same { proxyHost: null, ... } result, with applied: false and no SSH calls", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({ apply: true }, { ssh, inventory: noProxyInventory });
  assert.deepEqual(result, { proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE, applied: false });
  assert.equal(ssh.history.length, 0);
});

test("runSyncProxy under an unset proxyDriver (caddy default) is unchanged: proxyHost names the 'proxy: true' entry", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory });
  assert.equal(result.proxyHost, 'pve1');
  assert.equal(result.driver, 'caddy');
  assert.notEqual(result.preview, NO_PROXY_SYNC_MESSAGE);
});

// --- Traefik driver (issue #35, US1) -----------------------------------------
//
// One ungated guest route, mirroring the contract's *wiki* entry shape --
// the exact rendered-YAML text is pinned by test/lib/proxy/drivers/
// traefik.test.ts, so these tests only need to prove sync-proxy actually
// drives the Traefik driver (preview/apply/no-write), not re-pin the
// renderer's own output byte for byte.
const TRAEFIK_HEADER = '# Generated by Bellhop sync-proxy. Do not edit: this file is replaced on every apply.';
const traefikInventory: Inventory = {
  domain: 'example.com',
  proxyDriver: 'traefik',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [{ name: 'wiki-lxc', type: 'lxc', vmid: 100, host: 'pve1', ip: '192.0.2.20', port: 8080, subdomains: ['wiki', 'docs'] }],
};

test('sync-proxy (traefik driver) dry run previews the rendered YAML file and makes no SSH call', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: traefikInventory });
  assert.equal(result.driver, 'traefik');
  assert.equal(result.proxyHost, 'pve1');
  assert.equal(result.applied, false);
  assert.equal(result.preview.split('\n')[0], TRAEFIK_HEADER, 'preview starts with the owned-file header');
  assert.match(result.preview, /rule: Host\(`wiki\.example\.com`\) \|\| Host\(`docs\.example\.com`\)/);
  assert.match(result.preview, /certResolver: cloudflare/);
  assert.match(result.preview, /url: http:\/\/192\.0\.2\.20:8080/);
  assert.equal(ssh.history.length, 0, 'a dry run never touches SSH');
});

test('sync-proxy (traefik driver) --apply sends one script to the proxy host with the owned-file header check and an atomic mv -f, and no systemctl (Traefik reloads on its own)', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncProxy({ apply: true }, { ssh, inventory: traefikInventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  const script = ssh.history[0].command;
  assert.match(
    script,
    /if \[ -f '\/etc\/traefik\/dynamic\/bellhop\.yml' \] && \[ "\$\(head -n 1 '\/etc\/traefik\/dynamic\/bellhop\.yml'\)" != '# Generated by Bellhop sync-proxy\. Do not edit: this file is replaced on every apply\.' \]; then/,
    'refuses to replace a file this driver did not generate'
  );
  assert.match(script, /mv -f "\$TMP_0" '\/etc\/traefik\/dynamic\/bellhop\.yml'/, 'writes atomically via a same-directory temp file + mv -f');
  assert.ok(!script.includes('systemctl'), "Traefik's own file-provider watcher reloads it -- there is no reload command");
  assert.ok(!script.includes('curl'), 'no proxyApiUrl is set, so the apply script has no validate step (User Story 3)');
});

// User Story 3 (issue #35, T016): with proxyApiUrl set, a failed API check
// on the proxy host makes apply() throw -- this only has to prove
// runSyncProxy surfaces that failure to its caller, not re-pin the check
// script's own shape (test/lib/proxy/drivers/traefik.test.ts's executed
// tests already cover that).
test('sync-proxy (traefik driver, proxyApiUrl set) --apply throws with the check\'s own stderr, including the "Traefik API check failed" line', async () => {
  const checkStderr =
    'Traefik router bellhop-route-wiki-example-com is not healthy: {"status":"disabled","error":["the service does not exist"]}\n' +
    'Traefik API check failed; restored previous configuration\n';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: checkStderr, code: 1 }));
  const inventory: Inventory = { ...traefikInventory, proxyApiUrl: 'http://127.0.0.1:8080' };
  await assert.rejects(() => runSyncProxy({ apply: true }, { ssh, inventory }), (error: Error) => {
    assert.match(error.message, /Traefik router bellhop-route-wiki-example-com is not healthy/);
    assert.match(error.message, /Traefik API check failed; restored previous configuration/);
    return true;
  });
});

test('sync-proxy emits the configured Authentik outpost port', async () => {
  const original = process.env.AUTHENTIK_OUTPOST_PORT;
  process.env.AUTHENTIK_OUTPOST_PORT = '9100';
  try {
    const inventory: Inventory = {
      domain: 'example.com',
      hosts: [
        { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true },
        { name: 'auth-lxc-host', ssh_target: 'pve2.local', ssh_user: 'root', authentik: true, ip: '192.168.1.9' },
      ],
      guests: [
        { name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', port: 32400, subdomains: ['plex'], authGroup: 'bellhop-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const result = await runSyncProxy({}, { ssh, inventory });
    assert.match(result.preview, /forward_auth 192\.168\.1\.9:9100/);
    assert.doesNotMatch(result.preview, /:9000/);
  } finally {
    if (original === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = original;
  }
});

// issue #26: runSyncProxy under proxyDriver 'caddy-api' -- the driver has no
// config file, so orchestration must not require one, and the preview is
// the admin-API reconcile plan.
test('sync-proxy (caddy-api driver) previews the admin-API plan without needing a config path', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'HTTP/1.1 200 OK\r\nEtag: "/config/ 1"\r\n\r\nnull', stderr: '', code: 0 }));
  const result = await runSyncProxy({}, { ssh, inventory: { ...inventory, proxyDriver: 'caddy-api' } });
  assert.equal(result.driver, 'caddy-api');
  assert.equal(result.proxyHost, 'pve1');
  assert.equal(result.applied, false);
  assert.match(result.preview, /^\+ route media\.example\.com, movies\.example\.com -> 192\.168\.1\.50:8080$/m);
  assert.equal(ssh.history.length, 1);
});
