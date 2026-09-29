import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runSyncProxy } from '../../src/commands/networking/sync-proxy.ts';
import { registerDriverForTests } from '../../src/lib/proxy/index.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../src/lib/proxy/ids.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

// A driver that declares no forward-auth support -- exercises T034/FR-011's
// refusal path. `id` is cast through ProxyDriverId since PROXY_DRIVER_IDS
// only lists 'caddy' (src/lib/proxy/ids.ts); same convention as
// test/lib/proxy/{driver,index}.test.ts's own fakeDriver.
function oidcOnlyDriver(): ReverseProxyDriver {
  return {
    id: 'fake-oidc-only' as ProxyDriverId,
    label: 'Fake',
    capabilities: { authModes: ['oidc'], acmeDns01ViaCloudflare: false },
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
