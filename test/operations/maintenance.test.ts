import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAINTENANCE_OPERATIONS, toTargetSelector } from '../../src/operations/maintenance.ts';
import { parseOperationInput } from '../../src/operations/core.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import type { Inventory } from '../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { OperationDeps } from '../../src/operations/types.ts';
import { UPSTREAM_STABLE_BASE } from '../../src/lib/app-source.ts';
import { loadAppUpdateResults, upsertAppUpdateResult } from '../../src/lib/app-update-store.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'app-lxc', type: 'lxc', vmid: 4003, host: 'pve1' },
    { name: 'app-vm', type: 'vm', vmid: 4004, host: 'pve1' },
  ],
};

function deps(ssh = new FakeSSHClient(defaultResponder)): OperationDeps {
  return { ssh, inventory, inventoryPath: ':unused:', authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() };
}

// Fixtures shared with test/commands/check-app-updates.test.ts (research R10's
// post-update-apply re-check reuses checkOneGuest, so these tests exercise the
// exact same ct/<slug>.sh-parsing / GitHub-release-fetching path).
const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HOMEPAGE_SCRIPT = readFileSync(path.join(fixtureDir, 'community-scripts', 'homepage.sh'), 'utf8');
const RELEASES_LATEST = readFileSync(path.join(fixtureDir, 'github-releases', 'releases-latest.json'), 'utf8'); // tag_name "v1.1.0"
const ctUrl = (slug: string) => `${UPSTREAM_STABLE_BASE}/ct/${slug}.sh`;
const releasesLatestUrl = (repo: string) => `https://api.github.com/repos/${repo}/releases/latest`;

type Route = () => Response;
function routedFetch(routes: Record<string, Route>): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    const handler = routes[href];
    if (!handler) throw new Error(`unexpected fetch: ${href}`);
    return handler();
  }) as unknown as typeof fetch;
}
function ok(body: string): Route {
  return () => new Response(body, { status: 200 });
}

function appUpdateInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 101, host: 'pve1', app: 'homepage' }],
  };
}

function tempAppUpdateDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'update-app-recheck-')), 'bellhop.db');
}

test('toTargetSelector requires exactly one of host, all, group', () => {
  assert.deepEqual(toTargetSelector({ host: 'pve1' }), { host: 'pve1' });
  assert.deepEqual(toTargetSelector({ all: true }), { all: true });
  assert.deepEqual(toTargetSelector({ group: 'lxc' }), { group: 'lxc' });
  assert.throws(() => toTargetSelector({}), /exactly one/);
  assert.throws(() => toTargetSelector({ host: 'pve1', all: true }), /exactly one/);
});

test('update-all preview lists the resolved targets without running anything', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const op = MAINTENANCE_OPERATIONS['update-all'];
  const preview = await op.preview(parseOperationInput(op, { group: 'lxc' }), deps(ssh));
  assert.match(preview, /app-lxc/);
  assert.doesNotMatch(preview, /app-vm/);
  assert.equal(ssh.history.length, 0);
});

// Issue #2 (operator PR feedback): update-all must never act on VMs. Preview
// must call the same selectUpdateTargets used by apply, so preview == apply.
test('update-all preview with all excludes the VM guest', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const op = MAINTENANCE_OPERATIONS['update-all'];
  const preview = await op.preview(parseOperationInput(op, { all: true }), deps(ssh));
  assert.match(preview, /app-lxc/);
  assert.match(preview, /pve1/);
  assert.doesNotMatch(preview, /app-vm/);
  assert.equal(ssh.history.length, 0);
});

test('update-all preview with host naming a VM rejects', async () => {
  const op = MAINTENANCE_OPERATIONS['update-all'];
  await assert.rejects(
    () => op.preview(parseOperationInput(op, { host: 'app-vm' }), deps()),
    /update-all does not update VMs \(app-vm is a VM\); update packages inside the VM itself/
  );
});

test("update-all's group field no longer accepts 'vm' at all -- input parsing itself rejects it", () => {
  const op = MAINTENANCE_OPERATIONS['update-all'];
  assert.throws(() => parseOperationInput(op, { group: 'vm' }), /Invalid input for update-all/);
});

test('guest-power preview shows the command without running it', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const op = MAINTENANCE_OPERATIONS['guest-power'];
  const preview = await op.preview(parseOperationInput(op, { guest: 'app-lxc', state: 'start' }), deps(ssh));
  assert.match(preview, /pct start 4003/);
  assert.equal(ssh.history.length, 0);
});

test('guest-power apply fails when the remote command exits nonzero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'boom', code: 2 }));
  const op = MAINTENANCE_OPERATIONS['guest-power'];
  await assert.rejects(op.apply(parseOperationInput(op, { guest: 'app-lxc', state: 'shutdown' }), deps(ssh)), /exit 2/);
});

// Issue #33 US2: the sync-proxy operation must expose the same 'nothing to
// write' behavior as the CLI/runSyncProxy under proxyDriver: 'none' -- the
// preview already reads result.preview verbatim (so it needs no dedicated
// change), and apply must log the message since apply otherwise logs
// nothing at all today.
test("sync-proxy operation preview contains NO_PROXY_SYNC_MESSAGE under proxyDriver 'none'", async () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const op = MAINTENANCE_OPERATIONS['sync-proxy'];
  const preview = await op.preview(
    parseOperationInput(op, {}),
    { ssh, inventory: noneInventory, inventoryPath: ':unused:', authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() }
  );
  assert.match(preview, /proxyDriver is 'none' -- Bellhop manages no reverse proxy, so there is nothing to write/);
  assert.equal(ssh.history.length, 0);
});

test("sync-proxy operation apply logs NO_PROXY_SYNC_MESSAGE under proxyDriver 'none'", async () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const op = MAINTENANCE_OPERATIONS['sync-proxy'];
  const infos: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => infos.push(String(msg));
  try {
    await op.apply(
      parseOperationInput(op, {}),
      { ssh, inventory: noneInventory, inventoryPath: ':unused:', authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() }
    );
  } finally {
    console.log = originalLog;
  }
  assert.ok(infos.some((l) => l.includes("proxyDriver is 'none' -- Bellhop manages no reverse proxy, so there is nothing to write")));
  assert.equal(ssh.history.length, 0);
});

test('fleet-wide maintenance operations are flagged', () => {
  const fleetWide = Object.values(MAINTENANCE_OPERATIONS).filter((o) => o.fleetWide).map((o) => o.id).sort();
  assert.deepEqual(fleetWide, ['push-ssh-key', 'sync-inventory', 'sync-proxy', 'sync-ssh-keys', 'update-all']);
  assert.ok(!('sync-caddy' in MAINTENANCE_OPERATIONS), 'no sync-caddy alias');
});

// Issue #16: sync-inventory's apply replaces hosts/guests wholesale from live
// Proxmox state, but the settings scalars in `meta` are not its to touch. A
// setting written to disk by another process while the SSH queries run must
// survive the apply's save.
test('sync-inventory apply preserves a setting written to disk while the live queries were running', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-'));
  const inventoryPath = path.join(dir, 'bellhop.db');
  const inv: Inventory = { domain: 'example.com', hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }], guests: [] };
  saveInventory(inventoryPath, inv);
  let written = false;
  const ssh = new FakeSSHClient(() => {
    if (!written) {
      written = true;
      saveInventory(inventoryPath, { ...loadInventory(inventoryPath), dnsServer: '10.0.0.53' });
    }
    return { stdout: '[]', stderr: '', code: 0 };
  });
  const op = MAINTENANCE_OPERATIONS['sync-inventory'];
  await op.apply(parseOperationInput(op, {}), { ssh, inventory: { ...inv }, inventoryPath, authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() });
  assert.ok(written);
  assert.equal(loadInventory(inventoryPath).dnsServer, '10.0.0.53', 'a concurrently-written setting must not be reverted');
});

// Issue #61/US4, research R10: a successful update-app apply re-checks the
// guest's app-update status immediately, so the Update page badge doesn't go
// stale until the next scheduled check-app-updates run.
test('update-app apply with exit 0 upserts a fresh app-update result for that guest', async () => {
  const inv = appUpdateInventory();
  const inventoryPath = tempAppUpdateDbPath();
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('HOME:-/root')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });
  const op = MAINTENANCE_OPERATIONS['update-app'];
  await op.apply(parseOperationInput(op, { guest: 'media', app: 'homepage' }), {
    ssh,
    inventory: inv,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
    fetchImpl,
  });

  const results = loadAppUpdateResults(inventoryPath);
  assert.deepEqual(results, [
    {
      guest: 'media',
      app: 'homepage',
      status: 'update-available',
      installedVersion: '1.0.0',
      latestVersion: '1.1.0',
      repo: 'gethomepage/homepage',
      message: undefined,
      checkedAt: results[0].checkedAt,
    },
  ]);
});

test('update-app apply with a nonzero script exit skips the re-check and leaves the old row unchanged', async () => {
  const inv = appUpdateInventory();
  const inventoryPath = tempAppUpdateDbPath();
  const staleRow = {
    guest: 'media',
    app: 'homepage',
    status: 'up-to-date' as const,
    installedVersion: '0.9.0',
    latestVersion: '0.9.0',
    repo: 'gethomepage/homepage',
    message: undefined,
    checkedAt: '2026-01-01T00:00:00.000Z',
  };
  upsertAppUpdateResult(inventoryPath, staleRow);

  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'boom', code: 2 }));
  const op = MAINTENANCE_OPERATIONS['update-app'];
  await op.apply(parseOperationInput(op, { guest: 'media', app: 'homepage' }), {
    ssh,
    inventory: inv,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
  });

  assert.deepEqual(loadAppUpdateResults(inventoryPath), [staleRow]);
  assert.ok(!ssh.history.some((c) => c.command.includes('HOME:-/root')), 'the installed-version read must never run after a failed update');
});

test('update-app apply still resolves, logging a warning, when the post-apply re-check throws', async () => {
  const inv = appUpdateInventory();
  // A path that is itself a directory, not a file: openDb's own
  // mkdirSync(dirname(path)) happily creates the *parent*, but
  // better-sqlite3's `new Database()` still throws trying to open a
  // directory as a database file -- this is what forces
  // upsertAppUpdateResult to throw here, rather than checkOneGuest's own
  // (never-thrown, every failure returned as a value) error-result path.
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'update-app-recheck-')), 'bellhop.db');
  mkdirSync(inventoryPath);
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('HOME:-/root')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });
  const op = MAINTENANCE_OPERATIONS['update-app'];
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => warnings.push(String(msg));
  try {
    await op.apply(parseOperationInput(op, { guest: 'media', app: 'homepage' }), {
      ssh,
      inventory: inv,
      inventoryPath,
      authentik: new FakeAuthentikClient(),
      cloudflare: new UnconfiguredCloudflareClient(),
      fetchImpl,
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(warnings.some((l) => l.includes('media')), 'a failed re-check must be logged via logWarn, naming the guest');
});
