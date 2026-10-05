import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { syncProxyLive } from '../../src/web/proxy-sync.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import {
  CONFLICT_EXPLANATION,
  OAUTH2_CONFLICT_EXPLANATION,
  MOBILE_CONSENT_STAGE_NAME,
} from '../../src/commands/networking/sync-authentik.ts';
import { FakeCloudflareClient, txtRecord } from '../support/fake-cloudflare-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { PRUNE_ACME_SKIP_MESSAGE } from '../../src/web/proxy-sync.ts';
import { registerDriverForTests } from '../../src/lib/proxy/index.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../src/lib/proxy/driver.ts';
import { NO_PROXY_SYNC_MESSAGE } from '../../src/lib/proxy/driver.ts';
import { createNpmDriver, nginxProxyManagerDriver } from '../../src/lib/proxy/drivers/nginx-proxy-manager.ts';
import { FakeNpmClient } from '../support/fake-npm-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', subdomains: ['plex'] }],
};

test('syncProxyLive writes the managed Caddyfile block, then regenerates the status page', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  await syncProxyLive({ ssh, inventory, authentik: new FakeAuthentikClient() });

  // sync-proxy's write+reload, then render-status-page's read (cat) + write
  assert.equal(calls.length, 3);
  assert.match(calls[0], /caddy validate --adapter caddyfile/, 'first call is sync-proxy writing+reloading');
  assert.match(calls[1], /cat '\/etc\/caddy\/Caddyfile'/, 'second call is render-status-page reading the just-written file');
  assert.match(calls[2], /cat > '\/usr\/share\/caddy\/index\.html'/, 'third call is render-status-page writing the page');
  assert.match(calls[2], /live-caddyfile-content/, 'the page embeds what was just read back');
});

test('syncProxyLive propagates a sync-proxy failure without attempting the status page', async () => {
  const calls: string[] = [];
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  await assert.rejects(
    () => syncProxyLive({ ssh, inventory: noCaddy, authentik: new FakeAuthentikClient() }),
    /No inventory entry has 'proxy: true'/
  );
  assert.equal(calls.length, 0, 'sync-proxy never even reached an ssh call, so neither did the status page');
});

test('syncProxyLive skips the status page but still reconciles Authentik when statusPagePath is unset', async () => {
  const calls: string[] = [];
  const noStatusPage: Inventory = { ...inventory, statusPagePath: undefined };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  await syncProxyLive({ ssh, inventory: noStatusPage, authentik: new FakeAuthentikClient() });

  // Only sync-proxy's write+reload runs -- render-status-page's read (cat)
  // and write are skipped entirely, not just left unapplied.
  assert.equal(calls.length, 1);
  assert.match(calls[0], /caddy validate --adapter caddyfile/);
});

test('syncProxyLive also reconciles Authentik as a third step', async () => {
  const calls: string[] = [];
  const gatedInventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true },
    ],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const authentik = new FakeAuthentikClient();
  await syncProxyLive({ ssh, inventory: gatedInventory, authentik });

  const apps = await authentik.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'sonarr');
});

test('syncProxyLive skips sync-authentik when the Authentik API is not configured', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  // isConfigured() is false, and every other method throws -- proves
  // sync-authentik was never reached, not merely that it failed silently.
  const authentik = new UnconfiguredAuthentikClient();

  await syncProxyLive({ ssh, inventory, authentik });

  assert.equal(calls.length, 3, 'sync-proxy and render-status-page still ran');
});

test('syncProxyLive runs sync-authentik when the Authentik API is configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient();
  await syncProxyLive({ ssh, inventory, authentik });
  // FakeAuthentikClient records what it was asked for; reaching this line
  // without throwing means the third step ran against it.
  assert.ok(Array.isArray(await authentik.listApplications()));
});

test('syncProxyLive returns the slug conflicts sync-authentik reported', async () => {
  const gated: Inventory = {
    ...inventory,
    guests: [{ ...inventory.guests[0], authGroup: 'bellhop-users' }],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true, authentik: true, ip: '192.168.1.5' }],
  };
  // An Application already holds slug 'plex' backed by a provider that is
  // not in the fake's (empty) proxyProviders list.
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex.example.com', slug: 'plex', providerId: '99' }],
  });
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));

  const result = await syncProxyLive({ ssh, inventory: gated, authentik });
  assert.deepEqual(result.authentikConflicts, ['plex']);
});

test('syncProxyLive returns no conflicts when Authentik is not configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const result = await syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient() });
  assert.deepEqual(result.authentikConflicts, []);
});

test('syncProxyLive logWarns each conflict, since a Dashboard-triggered call runs outside any job log', async () => {
  const gated: Inventory = {
    ...inventory,
    guests: [{ ...inventory.guests[0], authGroup: 'bellhop-users' }],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true, authentik: true, ip: '192.168.1.5' }],
  };
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex.example.com', slug: 'plex', providerId: '99' }],
  });
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));

  const originalConsoleError = console.error;
  const errorLines: string[] = [];
  console.error = (message: string) => {
    errorLines.push(message);
  };
  try {
    await syncProxyLive({ ssh, inventory: gated, authentik });
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    errorLines.some((line) => line.includes(`sync-authentik: plex — ${CONFLICT_EXPLANATION}`)),
    'logWarn must be called with the conflicting entry name'
  );
});

// logInfo prefixes its lines, so match by substring.
function hasInfo(logs: { info: string[] }, message: string): boolean {
  return logs.info.some((l) => l.includes(message));
}

// Captures console.log/console.error lines for the duration of fn.
async function captureLogs(fn: () => Promise<unknown>): Promise<{ info: string[]; warn: string[] }> {
  const originalLog = console.log;
  const originalError = console.error;
  const info: string[] = [];
  const warn: string[] = [];
  console.log = (message: string) => {
    info.push(message);
  };
  console.error = (message: string) => {
    warn.push(message);
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { info, warn };
}

const STALE_MODIFIED_ON = '2020-01-01T00:00:00.000000Z';

test('syncProxyLive prunes stale _acme-challenge records as a fourth step when Cloudflare is configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('old', '_acme-challenge.gone.example.com', STALE_MODIFIED_ON)],
  });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.deepEqual(cloudflare.records, []);
  assert.ok(logs.info.some((l) => l.includes('prune-acme-challenges: deleted stale _acme-challenge.gone.example.com')));
});

test('syncProxyLive runs the prune only after sync-authentik', async () => {
  const events: string[] = [];
  class OrderedAuthentik extends FakeAuthentikClient {
    async listApplications() {
      events.push('authentik');
      return super.listApplications();
    }
  }
  class OrderedCloudflare extends FakeCloudflareClient {
    async findZoneId(domain: string) {
      events.push('cloudflare');
      return super.findZoneId(domain);
    }
  }
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  await syncProxyLive({ ssh, inventory, authentik: new OrderedAuthentik(), cloudflare: new OrderedCloudflare({ zones: { 'example.com': 'zone-1' } }) });
  assert.ok(events.includes('authentik'), 'sync-authentik ran');
  assert.equal(events.at(-1), 'cloudflare', 'the prune ran last');
  assert.ok(events.indexOf('cloudflare') > events.lastIndexOf('authentik'));
});

test('syncProxyLive logs a skip line and makes no Cloudflare call when Cloudflare is unconfigured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  // Every UnconfiguredCloudflareClient data method rejects, so reaching one
  // would surface as a warning below.
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() })
  );
  assert.ok(logs.info.some((l) => l.includes(PRUNE_ACME_SKIP_MESSAGE)));
  assert.equal(logs.warn.some((l) => l.includes('prune-acme-challenges')), false);
});

// A minimal fake driver, same shape/convention as
// test/lib/proxy/index.test.ts's own fakeDriver -- id is cast through
// Inventory['proxyDriver'] since PROXY_DRIVER_IDS only lists the shipped ids
// round (src/lib/proxy/ids.ts), and this test needs a second, test-only id
// to exercise the registry without touching the real driver list.
function fakeDriverWithoutAcme(id: string): ReverseProxyDriver {
  return {
    id: id as ReverseProxyDriver['id'],
    label: 'Fake',
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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

test('syncProxyLive skips the prune step (no Cloudflare calls) when the effective TLS source is not acme-dns via Cloudflare', async () => {
  const fake = fakeDriverWithoutAcme('fake-driver-no-acme-t016');
  const unregister = registerDriverForTests(fake);
  try {
    const noStatusPage: Inventory = {
      ...inventory,
      statusPagePath: undefined,
      proxyDriver: fake.id as Inventory['proxyDriver'],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
    const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
    const logs = await captureLogs(() =>
      syncProxyLive({ ssh, inventory: noStatusPage, authentik: new UnconfiguredAuthentikClient(), cloudflare })
    );
    assert.deepEqual(cloudflare.history, [], "the fake driver's default source is 'files', so the prune never runs");
    assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'files' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
  } finally {
    unregister();
  }
});

// The real nginx driver's (issue #30, US1) effective source is always
// 'files' (issue #72) -- unlike the tests above, no registerDriverForTests fake is
// needed here, since 'nginx' is a registered, shipped driver id.
test('syncProxyLive (real nginx driver) pushes nginx config and skips the ACME prune, never touching Cloudflare', async () => {
  const nginxInventory: Inventory = { ...inventory, statusPagePath: undefined, proxyDriver: 'nginx' };
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-nginx-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory: nginxInventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.equal(ssh.history.length, 1, 'only sync-proxy runs -- statusPagePath is unset and nothing is authGroup-gated');
  assert.match(ssh.history[0].command, /nginx -t/);
  assert.deepEqual(cloudflare.history, [], "nginx's TLS source is 'files', so the prune never calls Cloudflare");
  assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'files' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
});

// Issue #32 (US1): the real HAProxy driver never obtains a certificate
// itself (its source is always 'external'), so the prune is skipped the
// same way.
test('syncProxyLive (real haproxy driver) pushes HAProxy config and skips the ACME prune, never touching Cloudflare', async () => {
  const haproxyInventory: Inventory = { ...inventory, statusPagePath: undefined, proxyDriver: 'haproxy' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory: haproxyInventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.equal(ssh.history.length, 1, 'only sync-proxy runs -- statusPagePath is unset and nothing is authGroup-gated');
  assert.match(ssh.history[0].command, /haproxy -c -f \/etc\/haproxy\/haproxy\.cfg/);
  assert.deepEqual(cloudflare.history, []);
  assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'external' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
});

// Issue #31 (US5, T022): the Nginx Proxy Manager driver's source is always
// 'acme-http' (issue #72; it never touches DNS -- it either reuses an
// NPM certificate or has NPM request one over HTTP-01), so this is the same
// generic mechanism the fake-driver and real-nginx-driver tests above already
// exercise, just proven against the real registered 'nginx-proxy-manager'
// driver id. Its plan()/apply() talk to NPM's REST API, not SSH, so a fake
// NpmClient is registered over the real driver (createNpmDriver, the same
// factory the shipped driver is built from) to let sync-proxy's own step
// succeed without a network call -- and the real, buildNpmClient-backed
// driver is put back afterward, since registerDriverForTests's own unregister
// would otherwise delete the production registration for 'nginx-proxy-manager'
// entirely rather than restore it.
test('syncProxyLive (real Nginx Proxy Manager driver, fake client) pushes NPM config over REST, makes no SSH calls, and skips the ACME prune', async () => {
  const npmClient = new FakeNpmClient();
  const fakeClientDriver = createNpmDriver({ clientFor: () => npmClient });
  registerDriverForTests(fakeClientDriver);
  try {
    const npmInventory: Inventory = { ...inventory, statusPagePath: undefined, proxyDriver: 'nginx-proxy-manager' };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
    const logs = await captureLogs(() =>
      syncProxyLive({ ssh, inventory: npmInventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
    );
    assert.equal(ssh.history.length, 0, 'the NPM driver reconciles over REST, never SSH');
    assert.ok(npmClient.writes().length > 0, 'sanity: the fake NPM client actually applied the plex-lxc route');
    assert.deepEqual(cloudflare.history, [], "the NPM driver's TLS source is 'acme-http', so the prune never calls Cloudflare");
    assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'acme-http' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
  } finally {
    // Restore the real, buildNpmClient-backed driver under the same id --
    // registerDriverForTests's unregister() only deletes, it does not know
    // there was already a production entry to put back.
    registerDriverForTests(nginxProxyManagerDriver);
  }
});

// issue #72 (US3): the prune follows the effective TLS source alone (acme-dns
// with the cloudflare provider), not the driver's identity -- a deployment
// opts out of Cloudflare DNS-01 with tlsSource without switching drivers.
test('syncProxyLive (real caddy driver, tlsSource unset) still prunes Cloudflare', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.ok(cloudflare.history.length > 0, 'an unset tlsSource still means acme-dns via cloudflare, so the prune runs');
  assert.equal(logs.info.some((l) => l.includes('prune-acme-challenges: skipped, the TLS source')), false);
});

test("syncProxyLive (real caddy driver, tlsSource 'internal') skips the ACME prune, never touching Cloudflare", async () => {
  const internalInventory: Inventory = { ...inventory, tlsSource: 'internal' };
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory: internalInventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.deepEqual(cloudflare.history, [], "'internal' never touches Cloudflare DNS-01, so the prune never runs");
  assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'internal' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
});

// issue #72 (US3): every other Caddy source skips with its own name in the line.
for (const tlsSource of ['acme-http', 'files'] as const) {
  test(`syncProxyLive (real caddy driver, tlsSource '${tlsSource}') skips the ACME prune, never touching Cloudflare`, async () => {
    const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
    const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
    const logs = await captureLogs(() =>
      syncProxyLive({ ssh, inventory: { ...inventory, tlsSource }, authentik: new UnconfiguredAuthentikClient(), cloudflare })
    );
    assert.deepEqual(cloudflare.history, []);
    assert.ok(hasInfo(logs, `prune-acme-challenges: skipped, the TLS source is '${tlsSource}' (only acme-dns with the cloudflare DNS provider leaves challenge records)`));
  });
}

test("syncProxyLive (real caddy driver, tlsSource 'acme-dns') prunes Cloudflare", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  await syncProxyLive({ ssh, inventory: { ...inventory, tlsSource: 'acme-dns' }, authentik: new UnconfiguredAuthentikClient(), cloudflare });
  assert.ok(cloudflare.history.length > 0);
});

// Behavior change (US3 scenario 3): Traefik under acme-http names a resolver
// but leaves no DNS-01 challenge records, so it no longer prunes.
test("syncProxyLive (real traefik driver, tlsSource 'acme-http') skips the ACME prune", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory: { ...inventory, statusPagePath: undefined, proxyDriver: 'traefik', tlsSource: 'acme-http' }, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.deepEqual(cloudflare.history, []);
  assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'acme-http' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
});

test("syncProxyLive (real traefik driver, tlsSource 'acme-dns') prunes Cloudflare", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  await syncProxyLive({ ssh, inventory: { ...inventory, statusPagePath: undefined, proxyDriver: 'traefik', tlsSource: 'acme-dns' }, authentik: new UnconfiguredAuthentikClient(), cloudflare });
  assert.ok(cloudflare.history.length > 0);
});

test("syncProxyLive (real traefik driver, tlsSource 'external') skips the ACME prune, never touching Cloudflare", async () => {
  const traefikInventory: Inventory = { ...inventory, statusPagePath: undefined, proxyDriver: 'traefik', tlsSource: 'external' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory: traefikInventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.equal(ssh.history.length, 1, 'only sync-proxy runs -- statusPagePath is unset and nothing is authGroup-gated');
  assert.deepEqual(cloudflare.history, []);
  assert.ok(hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'external' (only acme-dns with the cloudflare DNS provider leaves challenge records)"));
});

// issue #26: the admin-API Caddy driver goes through the same push-live
// step -- it reads Caddy's configuration, PATCHes it, then the status page
// reads it back through the same admin API (FR-012, SC-006).
test('syncProxyLive (real caddy-api driver) reads and PATCHes Caddy through its admin API, then renders the status page from it', async () => {
  const apiInventory: Inventory = { ...inventory, proxyDriver: 'caddy-api' };
  const ssh = new FakeSSHClient((_t, _u, c) =>
    c.includes('-X PATCH')
      ? { stdout: '\nBELLHOP_HTTP_STATUS=200\n', stderr: '', code: 0 }
      : { stdout: 'HTTP/1.1 200 OK\r\nEtag: "/config/ 1"\r\n\r\nnull', stderr: '', code: 0 }
  );
  await syncProxyLive({ ssh, inventory: apiInventory, authentik: new UnconfiguredAuthentikClient() });
  const commands = ssh.history.map((h) => h.command);
  assert.match(commands[0], /systemctl is-active --quiet caddy\.service/, 'first call reads the config with the Caddyfile-mode check');
  assert.match(commands[1], /-X PATCH .*If-Match: "\/config\/ 1"/, 'second call writes it conditionally');
  assert.match(commands[1], /bellhop-route-plex\.example\.com/);
  assert.doesNotMatch(commands[2], /systemctl/, 'the status page reads without the check');
  assert.match(commands[3], /cat > '\/usr\/share\/caddy\/index\.html'/);
});

test('syncProxyLive treats an omitted cloudflare dep as unconfigured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const logs = await captureLogs(() => syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient() }));
  assert.ok(logs.info.some((l) => l.includes(PRUNE_ACME_SKIP_MESSAGE)));
});

test('syncProxyLive still resolves, with a warning, when the Cloudflare prune throws', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    listError: new Error('Cloudflare API 403: Authentication error'),
  });
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare });
  });
  assert.deepEqual(result, {
    authentikConflicts: [],
    authentikAdoptableConflicts: [],
    authentikOffLadder: [],
    authentikMissingRungs: [],
    authentikOidcSkipped: [],
    authentikForwardSkipped: [],
    authentikOidcDiscoveryFailures: [],
    authentikMobileConsentProblems: [],
  });
  assert.ok(logs.warn.some((l) => l.includes('prune-acme-challenges: skipped — Cloudflare API 403: Authentication error')));
});

test('syncProxyLive warns per failed delete and does not throw', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('bad', '_acme-challenge.gone.example.com', STALE_MODIFIED_ON)],
    failDeleteIds: ['bad'],
  });
  const logs = await captureLogs(() =>
    syncProxyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.ok(
    logs.warn.some((l) =>
      l.includes('prune-acme-challenges: could not delete _acme-challenge.gone.example.com — simulated delete failure for bad')
    )
  );
});

test('syncProxyLive never reaches the prune when sync-proxy fails', async () => {
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  await assert.rejects(
    () => syncProxyLive({ ssh, inventory: noCaddy, authentik: new FakeAuthentikClient(), cloudflare }),
    /No inventory entry has 'proxy: true'/
  );
  assert.deepEqual(cloudflare.history, []);
});

// Issue #33 US2: under proxyDriver: 'none', syncProxyLive must make no SSH
// calls at all (sync-proxy's own early return under 'none' means there is
// nothing to write, so render-status-page's read/write never happens
// either), log both the driver's status-page skip line and the ACME-prune
// TLS-source skip line, and still reconcile Authentik
// when it is configured -- exactly as today.
test("syncProxyLive under proxyDriver 'none' makes no SSH calls, logs both skip lines, and still runs sync-authentik", async () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  const ssh = new FakeSSHClient(() => ({ stdout: 'unused', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient();
  const logs = await captureLogs(() => syncProxyLive({ ssh, inventory: noneInventory, authentik }));

  assert.equal(ssh.history.length, 0, 'no SSH calls at all under a driver that manages no proxy');
  assert.ok(logs.info.some((l) => l.includes(NO_PROXY_SYNC_MESSAGE)), "sync-proxy's no-op message must be logged, not dropped");
  assert.ok(
    logs.info.some((l) => l.includes("proxyDriver is 'none' -- skipping the status page render")),
    'the driver status-page skip line must be logged'
  );
  assert.ok(
    hasInfo(logs, "prune-acme-challenges: skipped, the TLS source is 'external' (only acme-dns with the cloudflare DNS provider leaves challenge records)"),
    "the ACME-prune skip line (the none driver's source is 'external') must still be logged"
  );
  // FakeAuthentikClient records what it was asked for; reaching this line
  // without throwing means sync-authentik still ran against it.
  assert.ok(Array.isArray(await authentik.listApplications()));
});

// A driver that manages a proxy but serves no status page, with
// statusPagePath set: the operator configured a path that is being
// ignored, so the skip is a warning rather than an info line.
test('syncProxyLive warns (not info) when the active managed driver serves no status page but statusPagePath is set', async () => {
  const fake = fakeDriverWithoutAcme('fake-driver-no-status-page-warn');
  const unregister = registerDriverForTests(fake);
  try {
    const inv: Inventory = { ...inventory, proxyDriver: fake.id as Inventory['proxyDriver'] };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const logs = await captureLogs(() => syncProxyLive({ ssh, inventory: inv, authentik: new UnconfiguredAuthentikClient() }));
    const expected = `The '${fake.id}' proxy driver does not serve a status page -- skipping the status page render`;
    assert.ok(logs.warn.some((l) => l.includes(expected)), 'the skip must be a warning');
    assert.ok(!logs.info.some((l) => l.includes(expected)), 'and not also an info line');
  } finally {
    unregister();
  }
});

// Native OIDC gating (issue #1): sync-authentik's OIDC skips and failed
// discovery checks are warned and returned, and never fail the push.
function oidcGated(overrides: Partial<Inventory['guests'][number]> = {}): Inventory {
  return {
    ...inventory,
    guests: [
      {
        ...inventory.guests[0],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://plex.example.com/oauth/callback'],
        ...overrides,
      },
    ],
  };
}

test('syncProxyLive warns and returns each failed OIDC discovery check, and still resolves', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const fetchImpl = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({ ssh, inventory: oidcGated(), authentik: new FakeAuthentikClient(), fetchImpl });
  });
  assert.equal(result!.authentikOidcDiscoveryFailures.length, 1);
  const failure = result!.authentikOidcDiscoveryFailures[0];
  assert.equal(failure.slug, 'plex');
  assert.equal(failure.issuer, 'https://auth.example.com/application/o/plex/');
  assert.match(failure.error, /502/);
  assert.ok(logs.warn.some((l) => l.includes('sync-authentik: plex — OIDC discovery failed') && l.includes('502')));
});

test('syncProxyLive returns no discovery failures when the check passes', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const result = await syncProxyLive({ ssh, inventory: oidcGated(), authentik: new FakeAuthentikClient(), fetchImpl });
  assert.deepEqual(result.authentikOidcDiscoveryFailures, []);
  assert.deepEqual(result.authentikOidcSkipped, []);
});

test('syncProxyLive warns and returns each OIDC skip', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({
      ssh,
      inventory: oidcGated({ oidcRedirectUris: undefined }),
      authentik: new FakeAuthentikClient(),
    });
  });
  assert.deepEqual(
    result!.authentikOidcSkipped.map((s) => [s.slug, s.kind]),
    [['plex', 'missing-redirect-uris']]
  );
  assert.ok(logs.warn.some((l) => l.includes('sync-authentik: plex — OIDC skipped') && l.includes('oidcRedirectUris')));
});

// Final-review fix 2: a forward-auth entry skipped for a taken provider name
// is returned too, not only logged.
test('syncProxyLive warns and returns each forward-auth skip', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const gated: Inventory = {
    ...inventory,
    guests: [{ ...inventory.guests[0], authGroup: 'bellhop-users' }],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true, authentik: true, ip: '192.168.1.5' }],
  };
  // An unused OAuth2 provider already holds the name 'plex' -- the new
  // proxy provider cannot take it.
  const authentik = new FakeAuthentikClient({
    oauth2Providers: [
      { id: '70', name: 'plex', clientType: 'confidential', grantTypes: [], propertyMappingIds: [], redirectUris: [] },
    ],
  });
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({ ssh, inventory: gated, authentik });
  });
  assert.deepEqual(
    result!.authentikForwardSkipped.map((s) => [s.slug, s.kind]),
    [['plex', 'provider-name-taken']]
  );
  assert.ok(logs.warn.some((l) => l.includes('sync-authentik: plex — forward-auth skipped')));
});

// T016 (issue #22, research.md R10): syncProxyLive logWarns a mobile
// consent-step conflict or error the same way it already does for other
// instance-wide sync-authentik conditions (missingRungs, above), and (final
// review F3) also returns them as authentikMobileConsentProblems, since the
// Dashboard's guest PATCH runs outside any job and a logWarn alone never
// reaches the admin who saved a mobile redirect URI.
test('syncProxyLive logWarns a mobile consent conflict, prefixed for the mobile consent step', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient({
    // A same-named stage Bellhop did not create -- the same foreign-stage
    // conflict shape sync-authentik-mobile-consent.test.ts exercises.
    stages: [{ id: '600', name: MOBILE_CONSENT_STAGE_NAME, model: 'authentik_stages_prompt.promptstage' }],
  });
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({
      ssh,
      inventory: oidcGated({ oidcMobileRedirectUris: ['app.example:///oauth-callback'] }),
      authentik,
    });
  });
  assert.ok(
    logs.warn.some((l) =>
      l.includes(
        `sync-authentik: mobile consent — stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`
      )
    )
  );
  assert.ok(result, 'the call still resolves successfully despite the conflict');
  assert.deepEqual(result!.authentikMobileConsentProblems, [
    `stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`,
  ]);
});

test('syncProxyLive logWarns a mobile consent step error, and the call still resolves successfully', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient({ failOn: new Set(['createExpressionPolicy']) });
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({
      ssh,
      inventory: oidcGated({ oidcMobileRedirectUris: ['app.example:///oauth-callback'] }),
      authentik,
    });
  });
  assert.ok(
    logs.warn.some(
      (l) => l.includes('sync-authentik: mobile consent —') && l.includes('forced failure for createExpressionPolicy')
    )
  );
  assert.ok(result, 'the call still resolves successfully despite the mobile consent step failing');
  assert.equal(result!.authentikMobileConsentProblems.length, 1);
  assert.match(result!.authentikMobileConsentProblems[0], /forced failure for createExpressionPolicy/);
});

test('syncProxyLive returns no mobile consent problems when the consent step succeeds', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const result = await syncProxyLive({
    ssh,
    inventory: oidcGated({ oidcMobileRedirectUris: ['app.example:///oauth-callback'] }),
    authentik: new FakeAuthentikClient(),
  });
  assert.deepEqual(result.authentikMobileConsentProblems, []);
});

// Final-review fix 3 (FR-011): an adoptable conflict points at
// adopt-oidc-client in the log and is flagged in the result.
test('syncProxyLive returns adoptable conflicts and logs them with the adopt-oidc-client explanation', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient({
    oauth2Providers: [
      { id: '70', name: 'hand-made', clientType: 'confidential', grantTypes: [], propertyMappingIds: [], redirectUris: [] },
    ],
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex', slug: 'plex', providerId: '70' }],
  });
  let result: Awaited<ReturnType<typeof syncProxyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncProxyLive({ ssh, inventory: oidcGated(), authentik });
  });
  assert.deepEqual(result!.authentikConflicts, ['plex']);
  assert.deepEqual(result!.authentikAdoptableConflicts, ['plex']);
  assert.ok(logs.warn.some((l) => l.includes(`sync-authentik: plex — ${OAUTH2_CONFLICT_EXPLANATION}`)));
  assert.ok(!logs.warn.some((l) => l.includes(CONFLICT_EXPLANATION)), 'never the resolve-by-hand wording');
});

// Final review F3 (operator decision, FR-023): when sync-proxy fails -- e.g.
// a lasting Nginx Proxy Manager conflict on an unrelated route -- the push-live
// step still reconciles Authentik, so a guest just switched to OIDC still
// gets its OpenID client; it skips the status page and the ACME prune, then
// rethrows the original sync-proxy error so every caller keeps reporting the
// proxy failure as before.
test('syncProxyLive: a failing sync-proxy still runs sync-authentik, skips the status page and prune, and rethrows the same error', async () => {
  const failure = new Error('fake proxy apply failed: already in use');
  const snapshots: string[] = [];
  const failing: ReverseProxyDriver = {
    id: 'fake-driver-apply-throws-f3' as ReverseProxyDriver['id'],
    label: 'Fake',
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
    defaultConfigPath: '/etc/fake/fake.conf',
    statusPage: { suggestedPath: '/var/www/html/index.html' },
    async plan(): Promise<ProxyPlan> {
      return { preview: 'fake plan', payload: null };
    },
    async apply(): Promise<void> {
      throw failure;
    },
    async snapshot(): Promise<string> {
      snapshots.push('snapshot');
      return '';
    },
  };
  const unregister = registerDriverForTests(failing);
  try {
    const gated: Inventory = {
      domain: 'example.com',
      statusPagePath: '/var/www/html/index.html',
      proxyDriver: failing.id as Inventory['proxyDriver'],
      hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
      guests: [
        { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
        { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
      ],
    };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const authentik = new FakeAuthentikClient();
    const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
    let caught: unknown;
    const logs = await captureLogs(async () => {
      try {
        await syncProxyLive({ ssh, inventory: gated, authentik, cloudflare });
      } catch (err) {
        caught = err;
      }
    });

    assert.equal(caught, failure, 'rejects with the very same sync-proxy error');
    assert.ok(authentik.calls.includes('createApplication sonarr'), 'sync-authentik still ran');
    assert.deepEqual(snapshots, [], 'render-status-page never read the proxy configuration');
    assert.equal(ssh.history.length, 0, 'nor wrote a status page');
    assert.deepEqual(cloudflare.history, [], 'prune-acme-challenges never ran');
    assert.ok(logs.warn.some((l) => l.includes('fake proxy apply failed: already in use')), 'the failure is warned');
  } finally {
    unregister();
  }
});
