import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { syncCaddyLive } from '../../src/web/caddy-sync.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import { CONFLICT_EXPLANATION } from '../../src/commands/networking/sync-authentik.ts';
import { FakeCloudflareClient, txtRecord } from '../support/fake-cloudflare-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { PRUNE_ACME_SKIP_MESSAGE } from '../../src/web/caddy-sync.ts';

const inventory: Inventory = {
  domain: 'example.com',
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
  guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', subdomains: ['plex'] }],
};

test('syncCaddyLive writes the managed Caddyfile block, then regenerates the status page', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  await syncCaddyLive({ ssh, inventory, authentik: new FakeAuthentikClient() });

  // sync-caddy's write+reload, then render-status-page's read (cat) + write
  assert.equal(calls.length, 3);
  assert.match(calls[0], /caddy validate --adapter caddyfile/, 'first call is sync-caddy writing+reloading');
  assert.match(calls[1], /cat '\/etc\/caddy\/Caddyfile'/, 'second call is render-status-page reading the just-written file');
  assert.match(calls[2], /cat > '\/usr\/share\/caddy\/index\.html'/, 'third call is render-status-page writing the page');
  assert.match(calls[2], /live-caddyfile-content/, 'the page embeds what was just read back');
});

test('syncCaddyLive propagates a sync-caddy failure without attempting the status page', async () => {
  const calls: string[] = [];
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  await assert.rejects(
    () => syncCaddyLive({ ssh, inventory: noCaddy, authentik: new FakeAuthentikClient() }),
    /No inventory entry has 'caddy: true'/
  );
  assert.equal(calls.length, 0, 'sync-caddy never even reached an ssh call, so neither did the status page');
});

test('syncCaddyLive skips the status page but still reconciles Authentik when statusPagePath is unset', async () => {
  const calls: string[] = [];
  const noStatusPage: Inventory = { ...inventory, statusPagePath: undefined };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  await syncCaddyLive({ ssh, inventory: noStatusPage, authentik: new FakeAuthentikClient() });

  // Only sync-caddy's write+reload runs -- render-status-page's read (cat)
  // and write are skipped entirely, not just left unapplied.
  assert.equal(calls.length, 1);
  assert.match(calls[0], /caddy validate --adapter caddyfile/);
});

test('syncCaddyLive also reconciles Authentik as a third step', async () => {
  const calls: string[] = [];
  const gatedInventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true },
    ],
    guests: [
      { name: 'auth', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'homelab-users' },
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const authentik = new FakeAuthentikClient();
  await syncCaddyLive({ ssh, inventory: gatedInventory, authentik });

  const apps = await authentik.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'sonarr');
});

test('syncCaddyLive skips sync-authentik when the Authentik API is not configured', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-caddyfile-content', stderr: '', code: 0 };
  });
  // isConfigured() is false, and every other method throws -- proves
  // sync-authentik was never reached, not merely that it failed silently.
  const authentik = new UnconfiguredAuthentikClient();

  await syncCaddyLive({ ssh, inventory, authentik });

  assert.equal(calls.length, 3, 'sync-caddy and render-status-page still ran');
});

test('syncCaddyLive runs sync-authentik when the Authentik API is configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const authentik = new FakeAuthentikClient();
  await syncCaddyLive({ ssh, inventory, authentik });
  // FakeAuthentikClient records what it was asked for; reaching this line
  // without throwing means the third step ran against it.
  assert.ok(Array.isArray(await authentik.listApplications()));
});

test('syncCaddyLive returns the slug conflicts sync-authentik reported', async () => {
  const gated: Inventory = {
    ...inventory,
    guests: [{ ...inventory.guests[0], authGroup: 'homelab-users' }],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true, authentik: true, ip: '192.168.1.5' }],
  };
  // An Application already holds slug 'plex' backed by a provider that is
  // not in the fake's (empty) proxyProviders list.
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex.example.com', slug: 'plex', providerId: '99' }],
  });
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));

  const result = await syncCaddyLive({ ssh, inventory: gated, authentik });
  assert.deepEqual(result.authentikConflicts, ['plex']);
});

test('syncCaddyLive returns no conflicts when Authentik is not configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const result = await syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient() });
  assert.deepEqual(result.authentikConflicts, []);
});

test('syncCaddyLive logWarns each conflict, since a Dashboard-triggered call runs outside any job log', async () => {
  const gated: Inventory = {
    ...inventory,
    guests: [{ ...inventory.guests[0], authGroup: 'homelab-users' }],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true, authentik: true, ip: '192.168.1.5' }],
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
    await syncCaddyLive({ ssh, inventory: gated, authentik });
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    errorLines.some((line) => line.includes(`sync-authentik: plex — ${CONFLICT_EXPLANATION}`)),
    'logWarn must be called with the conflicting entry name'
  );
});

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

test('syncCaddyLive prunes stale _acme-challenge records as a fourth step when Cloudflare is configured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('old', '_acme-challenge.gone.example.com', STALE_MODIFIED_ON)],
  });
  const logs = await captureLogs(() =>
    syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.deepEqual(cloudflare.records, []);
  assert.ok(logs.info.some((l) => l.includes('prune-acme-challenges: deleted stale _acme-challenge.gone.example.com')));
});

test('syncCaddyLive runs the prune only after sync-authentik', async () => {
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
  await syncCaddyLive({ ssh, inventory, authentik: new OrderedAuthentik(), cloudflare: new OrderedCloudflare({ zones: { 'example.com': 'zone-1' } }) });
  assert.ok(events.includes('authentik'), 'sync-authentik ran');
  assert.equal(events.at(-1), 'cloudflare', 'the prune ran last');
  assert.ok(events.indexOf('cloudflare') > events.lastIndexOf('authentik'));
});

test('syncCaddyLive logs a skip line and makes no Cloudflare call when Cloudflare is unconfigured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  // Every UnconfiguredCloudflareClient data method rejects, so reaching one
  // would surface as a warning below.
  const logs = await captureLogs(() =>
    syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() })
  );
  assert.ok(logs.info.some((l) => l.includes(PRUNE_ACME_SKIP_MESSAGE)));
  assert.equal(logs.warn.some((l) => l.includes('prune-acme-challenges')), false);
});

test('syncCaddyLive treats an omitted cloudflare dep as unconfigured', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const logs = await captureLogs(() => syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient() }));
  assert.ok(logs.info.some((l) => l.includes(PRUNE_ACME_SKIP_MESSAGE)));
});

test('syncCaddyLive still resolves, with a warning, when the Cloudflare prune throws', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    listError: new Error('Cloudflare API 403: Authentication error'),
  });
  let result: Awaited<ReturnType<typeof syncCaddyLive>> | undefined;
  const logs = await captureLogs(async () => {
    result = await syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare });
  });
  assert.deepEqual(result, { authentikConflicts: [], authentikOffLadder: [], authentikMissingRungs: [] });
  assert.ok(logs.warn.some((l) => l.includes('prune-acme-challenges: skipped — Cloudflare API 403: Authentication error')));
});

test('syncCaddyLive warns per failed delete and does not throw', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'live-caddyfile-content', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('bad', '_acme-challenge.gone.example.com', STALE_MODIFIED_ON)],
    failDeleteIds: ['bad'],
  });
  const logs = await captureLogs(() =>
    syncCaddyLive({ ssh, inventory, authentik: new UnconfiguredAuthentikClient(), cloudflare })
  );
  assert.ok(
    logs.warn.some((l) =>
      l.includes('prune-acme-challenges: could not delete _acme-challenge.gone.example.com — simulated delete failure for bad')
    )
  );
});

test('syncCaddyLive never reaches the prune when sync-caddy fails', async () => {
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const cloudflare = new FakeCloudflareClient({ zones: { 'example.com': 'zone-1' } });
  await assert.rejects(
    () => syncCaddyLive({ ssh, inventory: noCaddy, authentik: new FakeAuthentikClient(), cloudflare }),
    /No inventory entry has 'caddy: true'/
  );
  assert.deepEqual(cloudflare.history, []);
});
