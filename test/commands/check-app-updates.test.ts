import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { saveInventory, type Inventory, type GuestEntry, type HostEntry } from '../../src/lib/inventory.ts';
import { loadAppUpdateResults, replaceAppUpdateResults } from '../../src/lib/app-update-store.ts';
import { UPSTREAM_STABLE_BASE, UPSTREAM_DEV_BASE } from '../../src/lib/app-source.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import {
  runCheckAppUpdates,
  checkOneGuest,
  formatCheckAppUpdates,
  type RunCheckAppUpdatesResult,
} from '../../src/commands/maintenance/check-app-updates.ts';

// Example values only (constitution Principle I): hosts `pve1`/`pve2`,
// guests like `media`/`web-lxc`, and demo owner/repo pairs throughout.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HOMEPAGE_SCRIPT = readFileSync(path.join(fixtureDir, 'community-scripts', 'homepage.sh'), 'utf8');
const RELEASES_LATEST = readFileSync(path.join(fixtureDir, 'github-releases', 'releases-latest.json'), 'utf8'); // tag_name "v1.1.0"
const NO_CHECK_SCRIPT = '#!/usr/bin/env bash\necho "nothing to see here"\n';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'check-app-updates-')), 'bellhop.db');
}

function host(name: string, overrides: Partial<HostEntry> = {}): HostEntry {
  return { name, ssh_target: `${name}.local`, ssh_user: 'root', ...overrides };
}

function guest(over: Partial<GuestEntry> & Pick<GuestEntry, 'name' | 'host' | 'vmid'>): GuestEntry {
  return { type: 'lxc', ...over } as GuestEntry;
}

const ctUrl = (slug: string) => `${UPSTREAM_STABLE_BASE}/ct/${slug}.sh`;
const devCtUrl = (slug: string) => `${UPSTREAM_DEV_BASE}/ct/${slug}.sh`;
const releasesLatestUrl = (repo: string) => `https://api.github.com/repos/${repo}/releases/latest`;

type Route = () => Response;

// Keyed by exact URL, same convention as test/lib/app-source.test.ts and
// test/lib/app-update-check.test.ts -- an unrouted URL throws loudly
// instead of silently 404ing or hanging.
function routedFetch(routes: Record<string, Route>, calls?: string[]): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    calls?.push(href);
    const handler = routes[href];
    if (!handler) throw new Error(`unexpected fetch: ${href}`);
    return handler();
  }) as unknown as typeof fetch;
}

function ok(body: string): Route {
  return () => new Response(body, { status: 200 });
}

function notFound(): Route {
  return () => new Response(null, { status: 404 });
}

// pvesh's own lxc/qemu listing shape (src/lib/guest-status.ts).
function pveshList(entries: { vmid: number; status: string }[]): string {
  return JSON.stringify(entries);
}

const PVE1 = host('pve1');
const PVE2 = host('pve2');

test('runCheckAppUpdates only checks lxc guests that have an app recorded', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [
      guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' }),
      guest({ name: 'novmid-vm', host: 'pve1', vmid: 102, type: 'vm', app: 'homepage' }),
      guest({ name: 'no-app', host: 'pve1', vmid: 103 }),
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([{ vmid: 102, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.deepEqual(result.results.map((r) => r.guest), ['media']);
  assert.ok(!ssh.history.some((c) => c.command.includes('pct exec 102')));
  assert.ok(!ssh.history.some((c) => c.command.includes('pct exec 103')));
});

test('a stopped guest is reported not-checked with no pct exec sent to it', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'db-lxc', host: 'pve1', vmid: 201, app: 'postgres' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 201, status: 'stopped' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({});

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.deepEqual(result.results, [
    { guest: 'db-lxc', app: 'postgres', status: 'not-checked', message: 'Guest is stopped', checkedAt: result.results[0].checkedAt },
  ]);
  assert.ok(!ssh.history.some((c) => c.command.includes('pct exec')));
});

test('a host whose status query fails still has its guests attempted', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1, PVE2],
    guests: [guest({ name: 'media2', host: 'pve2', vmid: 301, app: 'homepage' })],
  };
  const ssh = new FakeSSHClient((target, _u, command) => {
    if (target === 'pve1.local') return { stdout: pveshList([]), stderr: '', code: 0 };
    if (target === 'pve2.local' && (command.includes('/lxc ') || command.includes('/qemu ')))
      return { stdout: '', stderr: 'connection refused', code: 1 };
    if (command.includes('pct exec 301')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${target} ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].guest, 'media2');
  assert.equal(result.results[0].status, 'up-to-date');
  assert.ok(ssh.history.some((c) => c.command.includes('pct exec 301')));
});

test('a version-read exit 3 becomes an error suggesting running the update once', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '', stderr: '', code: 3 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({ [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT) });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].message!, /run the app's update once/);
  assert.equal(result.results[0].repo, 'gethomepage/homepage');
});

test('other version-read exit codes report an error naming the exit code', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '', stderr: 'disk read error', code: 2 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({ [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT) });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].message!, /exit 2/);
  assert.match(result.results[0].message!, /disk read error/);
});

test('the upstream script is fetched from stable, with a dev fallback on 404', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: 'devapp' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('devapp')]: notFound(),
    [devCtUrl('devapp')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results[0].status, 'up-to-date');
});

// --- custom script repository (issue #11), mirroring update-app.test.ts ---

const customFixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const HEAD_SHA_RAW = readFileSync(path.join(customFixtureDir, 'branch-head-sha.txt'), 'utf8');
const SHA = HEAD_SHA_RAW.trim();
const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
const COMPARE_AHEAD_BODY = readFileSync(path.join(customFixtureDir, 'compare-ahead-3-apps.json'), 'utf8');
const COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${CUSTOM_OWNER}:${CUSTOM_REPO}:${SHA}`;
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;

test('a custom source fetches ctUrl directly, with no upstream fallback', async () => {
  const slug = 'demo-shop';
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: slug })],
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [HEAD_SHA_URL]: ok(HEAD_SHA_RAW),
    [COMPARE_URL]: ok(COMPARE_AHEAD_BODY),
    [`${UPSTREAM_STABLE_BASE}/ct/${slug}.sh`]: notFound(),
    [`${UPSTREAM_DEV_BASE}/ct/${slug}.sh`]: notFound(),
    [customCtUrl(slug)]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results[0].status, 'up-to-date');
});

// --- unsupported / release errors ---

test('an unparseable script is reported unsupported', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'files-lxc', host: 'pve1', vmid: 401, app: 'samba' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 401, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({ [ctUrl('samba')]: ok(NO_CHECK_SCRIPT) });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.deepEqual(result.results[0], {
    guest: 'files-lxc',
    app: 'samba',
    status: 'unsupported',
    message: 'no check_for_gh_release call in ct/samba.sh',
    checkedAt: result.results[0].checkedAt,
  });
  assert.ok(!ssh.history.some((c) => c.command.includes('pct exec')), 'unsupported app must never be sent a version-read command');
});

test('a release fetch error is reported for that guest only', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [
      guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' }),
      guest({ name: 'web-lxc', host: 'pve1', vmid: 102, app: 'rate-limited-app' }),
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }, { vmid: 102, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    if (command.includes('pct exec 102')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const rateLimitedScript = NO_CHECK_SCRIPT.replace(
    'echo "nothing to see here"',
    'check_for_gh_release "rate-limited-app" "example-owner/rate-limited-app"'
  );
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
    [ctUrl('rate-limited-app')]: ok(rateLimitedScript),
    [releasesLatestUrl('example-owner/rate-limited-app')]: () => new Response('rate limited', { status: 403 }),
  });

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  const byGuest = Object.fromEntries(result.results.map((r) => [r.guest, r]));
  assert.equal(byGuest.media.status, 'up-to-date');
  assert.equal(byGuest['web-lxc'].status, 'error');
  assert.match(byGuest['web-lxc'].message!, /rate limit/);
});

test('two guests sharing a repository make only one release request', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [
      guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' }),
      guest({ name: 'media2', host: 'pve1', vmid: 102, app: 'homepage-mirror' }),
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }, { vmid: 102, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    if (command.includes('pct exec 102')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const releaseCalls: string[] = [];
  const fetchImpl = routedFetch(
    {
      [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
      [ctUrl('homepage-mirror')]: ok(HOMEPAGE_SCRIPT),
      [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
    },
    releaseCalls
  );

  const result = await runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl });
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.status === 'up-to-date'));
  assert.equal(releaseCalls.filter((u) => u === releasesLatestUrl('gethomepage/homepage')).length, 1);
});

// --- apply vs dry run ---

test('apply: false saves nothing; apply: true replaces all rows', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec 101')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });
  const dbPath = tempDbPath();
  saveInventory(dbPath, inventory);

  const dryRun = await runCheckAppUpdates({ apply: false }, { ssh, inventory, inventoryPath: dbPath, fetchImpl });
  assert.equal(dryRun.saved, false);
  assert.deepEqual(loadAppUpdateResults(dbPath), []);

  const applied = await runCheckAppUpdates({ apply: true }, { ssh, inventory, inventoryPath: dbPath, fetchImpl });
  assert.equal(applied.saved, true);
  assert.equal(loadAppUpdateResults(dbPath).length, 1);
  assert.equal(loadAppUpdateResults(dbPath)[0].guest, 'media');
});

// --- --guest mode ---

test('--guest mode skips the status query and upserts just that one row', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [
      guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' }),
      guest({ name: 'other', host: 'pve1', vmid: 102, app: 'homepage' }),
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ') || command.includes('/qemu ')) throw new Error('status query should not be called in --guest mode');
    if (command.includes('pct exec 101')) return { stdout: '1.0.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });
  const dbPath = tempDbPath();
  saveInventory(dbPath, inventory);

  const result = await runCheckAppUpdates({ guest: 'media', apply: true }, { ssh, inventory, inventoryPath: dbPath, fetchImpl });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].guest, 'media');
  assert.equal(result.saved, true);
  const saved = loadAppUpdateResults(dbPath);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].guest, 'media');
});

test('--guest mode rejects an unknown guest', async () => {
  const inventory: Inventory = { domain: 'example.com', hosts: [PVE1], guests: [] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCheckAppUpdates({ guest: 'nope' }, { ssh, inventory, inventoryPath: tempDbPath() }),
    /Unknown inventory entry: nope/
  );
});

test('--guest mode rejects a non-lxc guest', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'db-vm', host: 'pve1', vmid: 501, type: 'vm', app: 'postgres' })],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCheckAppUpdates({ guest: 'db-vm' }, { ssh, inventory, inventoryPath: tempDbPath() }),
    /db-vm is not an LXC guest -- check-app-updates only checks LXC guests/
  );
});

test('--guest mode rejects a guest with no app recorded', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'bare-lxc', host: 'pve1', vmid: 601 })],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCheckAppUpdates({ guest: 'bare-lxc' }, { ssh, inventory, inventoryPath: tempDbPath() }),
    /bare-lxc has no community-scripts app recorded -- nothing to check/
  );
});

// --- checkOneGuest (used directly by the update-app re-check, research R10) ---

test('checkOneGuest works standalone with no caches given', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' })],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('pct exec 101')) return { stdout: '1.1.0\n', stderr: '', code: 0 };
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  const result = await checkOneGuest('media', { ssh, inventory, fetchImpl });
  assert.equal(result.guest, 'media');
  assert.equal(result.status, 'up-to-date');
});

// --- formatCheckAppUpdates (contracts/cli.md's line layout) ---

test('formatCheckAppUpdates matches the contract line layout', () => {
  const result: RunCheckAppUpdatesResult = {
    saved: true,
    results: [
      {
        guest: 'media',
        app: 'jellyseerr',
        status: 'update-available',
        installedVersion: '1.2.3',
        latestVersion: '1.3.0',
        repo: 'example-owner/example-app',
        checkedAt: '2026-10-01T04:00:00.000Z',
      },
      {
        guest: 'web-lxc',
        app: 'homepage',
        status: 'error',
        message: 'GitHub API rate limit reached; the next scheduled check will retry',
        checkedAt: '2026-10-01T04:00:00.000Z',
      },
      {
        guest: 'files-lxc',
        app: 'samba',
        status: 'unsupported',
        message: 'no check_for_gh_release call in ct/samba.sh',
        checkedAt: '2026-10-01T04:00:00.000Z',
      },
      {
        guest: 'db-lxc',
        app: 'postgres',
        status: 'not-checked',
        message: 'Guest is stopped',
        checkedAt: '2026-10-01T04:00:00.000Z',
      },
    ],
  };
  const expected = [
    'media       jellyseerr  update available  1.2.3 -> 1.3.0   (example-owner/example-app)',
    'web-lxc     homepage    error             GitHub API rate limit reached; the next scheduled check will retry',
    'files-lxc   samba       unsupported       no check_for_gh_release call in ct/samba.sh',
    'db-lxc      postgres    not checked       Guest is stopped',
  ].join('\n');
  assert.equal(formatCheckAppUpdates(result), expected);
});

// --- cancellation (final review) ---

function cancelInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [PVE1],
    guests: [
      guest({ name: 'media', host: 'pve1', vmid: 101, app: 'homepage' }),
      guest({ name: 'web-lxc', host: 'pve1', vmid: 102, app: 'homepage' }),
    ],
  };
}

// The store reads unset optional columns back as undefined keys; drop them
// so a row compares equal to the literal it was saved from.
function storedRows(dbPath: string): unknown[] {
  return JSON.parse(JSON.stringify(loadAppUpdateResults(dbPath)));
}

const PREVIOUS_ROW = {
  guest: 'media',
  app: 'homepage',
  status: 'up-to-date' as const,
  installedVersion: '1.1.0',
  repo: 'gethomepage/homepage',
  checkedAt: '2026-10-02T04:00:00.000Z',
};

test('a run cancelled mid-check throws and leaves the saved results untouched', async () => {
  const inventory = cancelInventory();
  const dbPath = tempDbPath();
  saveInventory(dbPath, inventory);
  replaceAppUpdateResults(dbPath, [PREVIOUS_ROW]);
  const controller = new AbortController();
  // Mirrors JobSSHClient after a cancel: the in-flight exec and every later
  // one reject with 'Job cancelled'.
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: pveshList([{ vmid: 101, status: 'running' }, { vmid: 102, status: 'running' }]), stderr: '', code: 0 };
    if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
    if (command.includes('pct exec')) {
      controller.abort();
      throw new Error('Job cancelled');
    }
    throw new Error(`unexpected ssh command: ${command}`);
  });
  const fetchImpl = routedFetch({
    [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
    [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
  });

  await assert.rejects(
    runCheckAppUpdates({ apply: true }, { ssh, inventory, inventoryPath: dbPath, fetchImpl, signal: controller.signal }),
    /cancelled/
  );
  assert.deepEqual(storedRows(dbPath), [PREVIOUS_ROW]);
});

test('an already-cancelled run contacts no guest and saves nothing', async () => {
  const inventory = cancelInventory();
  const dbPath = tempDbPath();
  saveInventory(dbPath, inventory);
  replaceAppUpdateResults(dbPath, [PREVIOUS_ROW]);
  const controller = new AbortController();
  controller.abort();
  const ssh = new FakeSSHClient(() => {
    throw new Error('no ssh expected');
  });

  await assert.rejects(
    runCheckAppUpdates({ apply: true }, { ssh, inventory, inventoryPath: dbPath, fetchImpl: routedFetch({}), signal: controller.signal }),
    /cancelled/
  );
  assert.equal(ssh.history.length, 0);
  assert.deepEqual(storedRows(dbPath), [PREVIOUS_ROW]);
});

test('a --guest run cancelled mid-check does not upsert its error row', async () => {
  const inventory = cancelInventory();
  const dbPath = tempDbPath();
  saveInventory(dbPath, inventory);
  replaceAppUpdateResults(dbPath, [PREVIOUS_ROW]);
  const controller = new AbortController();
  const ssh = new FakeSSHClient(() => {
    controller.abort();
    throw new Error('Job cancelled');
  });
  const fetchImpl = routedFetch({ [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT) });

  await assert.rejects(
    runCheckAppUpdates({ guest: 'media', apply: true }, { ssh, inventory, inventoryPath: dbPath, fetchImpl, signal: controller.signal }),
    /cancelled/
  );
  assert.deepEqual(storedRows(dbPath), [PREVIOUS_ROW]);
});

// --- concurrency (final review) ---

test('a full run checks at most four guests at once, results still sorted by guest', async () => {
  const names = ['g6', 'g5', 'g4', 'g3', 'g2', 'g1'];
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [PVE1],
    guests: names.map((name, i) => guest({ name, host: 'pve1', vmid: 201 + i, app: 'homepage' })),
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const gate: (() => void)[] = [];
  // Version reads park on `gate` until the test releases them, so the
  // number parked at once is exactly the number of guests in flight.
  const ssh = {
    async exec(_target: unknown, command: string) {
      if (command.includes('/lxc ')) {
        return { stdout: pveshList(names.map((_n, i) => ({ vmid: 201 + i, status: 'running' }))), stderr: '', code: 0 };
      }
      if (command.includes('/qemu ')) return { stdout: pveshList([]), stderr: '', code: 0 };
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gate.push(resolve));
      inFlight--;
      return { stdout: '1.1.0\n', stderr: '', code: 0 };
    },
  } as unknown as FakeSSHClient;
  const releaseCalls: string[] = [];
  const fetchImpl = routedFetch(
    {
      [ctUrl('homepage')]: ok(HOMEPAGE_SCRIPT),
      [releasesLatestUrl('gethomepage/homepage')]: ok(RELEASES_LATEST),
    },
    releaseCalls
  );

  let done = false;
  const run = runCheckAppUpdates({}, { ssh, inventory, inventoryPath: tempDbPath(), fetchImpl }).finally(() => {
    done = true;
  });
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  let rounds = 0;
  while (!done && rounds++ < 20) {
    await settle();
    if (rounds === 1) assert.equal(inFlight, 4, 'four guests in flight before any finishes');
    gate.splice(0).forEach((release) => release());
  }
  const result = await run;
  assert.equal(maxInFlight, 4);
  assert.deepEqual(result.results.map((r) => r.guest), ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
  assert.ok(result.results.every((r) => r.status === 'up-to-date'));
  assert.equal(releaseCalls.filter((u) => u === ctUrl('homepage')).length, 1);
  assert.equal(releaseCalls.filter((u) => u === releasesLatestUrl('gethomepage/homepage')).length, 1);
});
