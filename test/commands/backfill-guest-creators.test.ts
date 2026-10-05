import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, type Inventory, type GuestEntry } from '../../src/lib/inventory.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { UnconfiguredAuthentikClient, UNCONFIGURED_MESSAGE } from '../../src/lib/authentik-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import {
  runBackfillGuestCreators,
  formatBackfillGuestCreators,
  type BackfillReport,
} from '../../src/commands/maintenance/backfill-guest-creators.ts';

const TEST_UID = 'a'.repeat(64);
const ADMIN_UID = 'b'.repeat(64);

function guest(over: Partial<GuestEntry> & Pick<GuestEntry, 'name' | 'host' | 'vmid' | 'type'>): GuestEntry {
  return { ...over } as GuestEntry;
}

function fixtureInventory(guests: GuestEntry[]): Inventory {
  return {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.1.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.2.1' } },
    ],
    guests,
  };
}

const DEFAULT_GUESTS = [
  guest({ name: 'web-lxc', host: 'pve1', vmid: 4004, type: 'lxc' }),
  guest({ name: 'demo-vm', host: 'pve2', vmid: 5007, type: 'vm' }),
];

function users() {
  return new FakeAuthentikClient({
    users: [
      { id: '1', username: 'test-user', uid: TEST_UID, email: 'test-user@example.com', isActive: true, groupIds: [] },
      { id: '2', username: 'admin', uid: ADMIN_UID, email: 'admin@example.com', isActive: true, groupIds: [] },
    ],
  });
}

interface JobSpec {
  command: string;
  args: Record<string, unknown> | string;
  user?: string | null;
  status?: 'success' | 'failed' | 'cancelled' | 'interrupted';
  via?: 'web' | 'mcp';
}

function setup(guests: GuestEntry[] = DEFAULT_GUESTS) {
  const dir = mkdtempSync(path.join(tmpdir(), 'backfill-'));
  const inventoryPath = path.join(dir, 'bellhop.db');
  saveInventory(inventoryPath, fixtureInventory(guests));
  const jobStore = new JobStore(path.join(dir, 'jobs.sqlite3'));
  const addJob = (spec: JobSpec): number => {
    const id = jobStore.createJob({
      command: spec.command,
      category: 'provisioning',
      argsJson: typeof spec.args === 'string' ? spec.args : JSON.stringify(spec.args),
      ...(spec.user === null ? {} : { triggeredByUsername: spec.user ?? 'test-user' }),
      ...(spec.via ? { triggeredVia: spec.via } : {}),
      owner: 'web',
    });
    const status = spec.status ?? 'success';
    if (status === 'interrupted') return id; // left queued, interrupted below
    jobStore.markRunning(id);
    jobStore.markFinished(id, { status, exitCode: status === 'success' ? 0 : 1 });
    return id;
  };
  const run = (
    opts: { maps?: string[]; apply?: boolean; localOperator?: string; inventory?: Inventory } = {},
    authentik = users()
  ) => {
    jobStore.interruptOrphaned('web', () => false);
    return runBackfillGuestCreators(
      { maps: opts.maps ?? [], apply: opts.apply ?? false, localOperator: opts.localOperator ?? 'local' },
      { inventory: opts.inventory ?? loadInventory(inventoryPath), inventoryPath, jobStore, authentik }
    );
  };
  const startedAt = (id: number): string => jobStore.get(id)!.startedAt!;
  return { inventoryPath, jobStore, addJob, run, startedAt };
}

const creatorOf = (inventoryPath: string, name: string) => loadInventory(inventoryPath).guests.find((g) => g.name === name)?.creator;

test('matches create-lxc/install-app by hostname and create-vm/deploy-vpn-gateway by name', async () => {
  const guests = [
    ...DEFAULT_GUESTS,
    guest({ name: 'media', host: 'pve1', vmid: 4009, type: 'lxc' }),
    guest({ name: 'nordvpn-us-gw-lxc', host: 'pve2', vmid: 5020, type: 'lxc' }),
  ];
  const { addJob, run } = setup(guests);
  const j1 = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const j2 = addJob({ command: 'create-vm', args: { host: 'pve2', mid: 7, name: 'demo-vm' }, user: 'admin' });
  const j3 = addJob({ command: 'install-app', args: { host: 'pve1', mid: '9', hostname: 'media', app: 'example' } });
  const j4 = addJob({ command: 'deploy-vpn-gateway', args: { host: 'pve2', mid: '20', name: 'nordvpn-us-gw-lxc' } });
  const report = await run();
  assert.deepEqual(
    report.updates.map((u) => [u.guest, u.host, u.vmid, u.username, u.uid, u.jobId]).sort(),
    [
      ['demo-vm', 'pve2', 5007, 'admin', ADMIN_UID, j2],
      ['media', 'pve1', 4009, 'test-user', TEST_UID, j3],
      ['nordvpn-us-gw-lxc', 'pve2', 5020, 'test-user', TEST_UID, j4],
      ['web-lxc', 'pve1', 4004, 'test-user', TEST_UID, j1],
    ].sort()
  );
  assert.deepEqual(report.skipped, []);
  assert.equal(report.applied, false);
});

test('the newest successful job wins and older ones are reported superseded', async () => {
  const { addJob, run } = setup();
  const older = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' }, user: 'admin' });
  const newer = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const report = await run();
  assert.deepEqual(report.updates.map((u) => [u.guest, u.username, u.jobId]), [['web-lxc', 'test-user', newer]]);
  assert.deepEqual(report.skipped.map((s) => [s.jobId, s.reason]), [[older, 'superseded']]);
});

test('failed, cancelled, interrupted, mcp and user-less jobs are skipped silently', async () => {
  const { addJob, run } = setup();
  const args = { host: 'pve1', mid: '4', hostname: 'web-lxc' };
  addJob({ command: 'create-lxc', args, status: 'failed' });
  addJob({ command: 'create-lxc', args, status: 'cancelled' });
  addJob({ command: 'create-lxc', args, status: 'interrupted' });
  addJob({ command: 'create-lxc', args, user: 'mcp' });
  // #65/#66: an MCP job now records a real username, but MCP still never
  // records a creator, so it is skipped by its front end.
  addJob({ command: 'create-lxc', args, user: 'admin', via: 'mcp' });
  addJob({ command: 'create-lxc', args, user: null });
  addJob({ command: 'update-app', args: { guest: 'web-lxc' } });
  const report = await run();
  assert.deepEqual(report.updates, []);
  assert.deepEqual(report.skipped, []);
});

test('an unknown login is skipped as unknown-user, and --map resolves it to the current user', async () => {
  const { addJob, run, inventoryPath, startedAt } = setup();
  const id = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' }, user: 'old-login' });
  const unmapped = await run();
  assert.deepEqual(unmapped.updates, []);
  assert.equal(unmapped.skipped.length, 1);
  assert.equal(unmapped.skipped[0].jobId, id);
  assert.equal(unmapped.skipped[0].reason, 'unknown-user');
  assert.match(unmapped.skipped[0].detail, /old-login; pass --map old-login=<current username>/);

  const mapped = await run({ maps: ['old-login=test-user'], apply: true });
  assert.deepEqual(mapped.skipped, []);
  assert.deepEqual(mapped.updates.map((u) => [u.guest, u.username, u.uid]), [['web-lxc', 'test-user', TEST_UID]]);
  assert.deepEqual(creatorOf(inventoryPath, 'web-lxc'), { uid: TEST_UID, username: 'test-user', since: startedAt(id) });
});

test('a malformed --map throws naming the flag', async () => {
  const { run } = setup();
  for (const bad of ['old-login', '=test-user', 'old-login=', '=']) {
    await assert.rejects(run({ maps: [bad] }), /--map/);
  }
});

test('a guest that already has a creator is never overwritten', async () => {
  const guests = [guest({ name: 'web-lxc', host: 'pve1', vmid: 4004, type: 'lxc', creator: { username: 'admin', uid: ADMIN_UID } })];
  const { addJob, run, inventoryPath } = setup(guests);
  const id = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const report = await run({ apply: true });
  assert.deepEqual(report.updates, []);
  assert.deepEqual(report.skipped.map((s) => [s.jobId, s.reason, s.detail]), [[id, 'already-has-creator', 'web-lxc']]);
  assert.deepEqual(creatorOf(inventoryPath, 'web-lxc'), { username: 'admin', uid: ADMIN_UID });
});

test('no-matching-guest when the VMID or the name differs', async () => {
  const { addJob, run } = setup();
  const wrongVmid = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '9', hostname: 'web-lxc' } });
  const wrongName = addJob({ command: 'create-vm', args: { host: 'pve2', mid: '7', name: 'media' } });
  const report = await run();
  assert.deepEqual(report.updates, []);
  const byId = new Map(report.skipped.map((s) => [s.jobId, s]));
  assert.equal(byId.get(wrongVmid)?.reason, 'no-matching-guest');
  assert.equal(byId.get(wrongVmid)?.detail, 'web-lxc on pve1, vmid 4009');
  assert.equal(byId.get(wrongName)?.reason, 'no-matching-guest');
  assert.equal(byId.get(wrongName)?.detail, 'media on pve2, vmid 5007');
});

test('unparseable-args on bad JSON, a missing mid, or an unknown host', async () => {
  const { addJob, run } = setup();
  const badJson = addJob({ command: 'create-lxc', args: '{not json' });
  const noMid = addJob({ command: 'create-lxc', args: { host: 'pve1', hostname: 'web-lxc' } });
  const noName = addJob({ command: 'create-vm', args: { host: 'pve2', mid: '7' } });
  const badHost = addJob({ command: 'create-lxc', args: { host: 'pve9', mid: '4', hostname: 'web-lxc' } });
  const report = await run();
  assert.deepEqual(report.updates, []);
  assert.deepEqual(
    report.skipped.map((s) => [s.jobId, s.reason]).sort(),
    [badJson, noMid, noName, badHost].map((id) => [id, 'unparseable-args']).sort()
  );
});

test('a dry run writes nothing', async () => {
  const { addJob, run, inventoryPath } = setup();
  addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const report = await run();
  assert.equal(report.updates.length, 1);
  assert.equal(report.applied, false);
  assert.equal(creatorOf(inventoryPath, 'web-lxc'), undefined);
});

test('--apply saves creator { uid, username, since } with the current Authentik username and the job start time', async () => {
  const { addJob, run, inventoryPath, startedAt } = setup();
  const lxcJob = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const vmJob = addJob({ command: 'create-vm', args: { host: 'pve2', mid: '7', name: 'demo-vm' }, user: 'admin' });
  const report = await run({ apply: true });
  assert.equal(report.applied, true);
  assert.deepEqual(
    report.updates.map((u) => [u.guest, u.since]).sort(),
    [
      ['demo-vm', startedAt(vmJob)],
      ['web-lxc', startedAt(lxcJob)],
    ]
  );
  assert.deepEqual(creatorOf(inventoryPath, 'web-lxc'), { uid: TEST_UID, username: 'test-user', since: startedAt(lxcJob) });
  assert.deepEqual(creatorOf(inventoryPath, 'demo-vm'), { uid: ADMIN_UID, username: 'admin', since: startedAt(vmJob) });
});

test('a user with no uid is recorded by username only', async () => {
  const { addJob, run, inventoryPath, startedAt } = setup();
  const id = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const authentik = new FakeAuthentikClient({
    users: [{ id: '1', username: 'test-user', uid: '', email: 'test-user@example.com', isActive: true, groupIds: [] }],
  });
  const report = await run({ apply: true }, authentik);
  assert.equal(report.updates[0].uid, undefined);
  assert.deepEqual(creatorOf(inventoryPath, 'web-lxc'), { username: 'test-user', since: startedAt(id) });
});

test('an unconfigured Authentik fails with the client message', async () => {
  const { addJob, run } = setup();
  addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  await assert.rejects(run({}, new UnconfiguredAuthentikClient() as unknown as FakeAuthentikClient), (err: Error) => err.message === UNCONFIGURED_MESSAGE);
});

test('formatBackfillGuestCreators renders the contract output', () => {
  const report: BackfillReport = {
    updates: [
      { guest: 'web-lxc', host: 'pve1', vmid: 4004, username: 'test-user', uid: TEST_UID, jobId: 12 },
      { guest: 'demo-vm', host: 'pve2', vmid: 5007, username: 'admin', uid: ADMIN_UID, jobId: 31 },
    ],
    skipped: [
      { jobId: 7, command: 'install-app', reason: 'unknown-user', detail: 'old-login; pass --map old-login=<current username>' },
      { jobId: 9, command: 'create-lxc', reason: 'no-matching-guest', detail: 'media on pve1, vmid 4009' },
      { jobId: 15, command: 'install-app', reason: 'already-has-creator', detail: 'web-lxc' },
    ],
    applied: false,
  };
  assert.equal(
    formatBackfillGuestCreators(report),
    [
      'Would record creators for 2 guest(s):',
      '  + web-lxc (pve1, vmid 4004): test-user  [job 12]',
      '  + demo-vm (pve2, vmid 5007): admin  [job 31]',
      'Skipped 3 job(s):',
      '  - job 7 install-app: unknown-user (old-login; pass --map old-login=<current username>)',
      '  - job 9 create-lxc: no-matching-guest (media on pve1, vmid 4009)',
      '  - job 15 install-app: already-has-creator (web-lxc)',
      'Dry run -- re-run with --apply to write these.',
    ].join('\n')
  );
  const applied = formatBackfillGuestCreators({ ...report, skipped: [], applied: true });
  assert.equal(
    applied,
    [
      'Recorded creators for 2 guest(s):',
      '  + web-lxc (pve1, vmid 4004): test-user  [job 12]',
      '  + demo-vm (pve2, vmid 5007): admin  [job 31]',
    ].join('\n')
  );
});

// Final review (#58), finding 4: a job the synthetic local operator triggered
// is no real person, so it is skipped silently exactly like an MCP job.
test('jobs triggered by the local operator are skipped silently, under the default or a configured name', async () => {
  const { addJob, run } = setup();
  const args = { host: 'pve1', mid: '4', hostname: 'web-lxc' };
  addJob({ command: 'create-lxc', args, user: 'local' });
  const byDefault = await run();
  assert.deepEqual(byDefault.updates, []);
  assert.deepEqual(byDefault.skipped, []);

  addJob({ command: 'create-vm', args: { host: 'pve2', mid: '7', name: 'demo-vm' }, user: 'operator' });
  const configured = await run({ localOperator: 'operator' });
  // 'operator' is skipped; 'local' is now an ordinary (unknown) login.
  assert.deepEqual(configured.updates, []);
  assert.deepEqual(configured.skipped.map((s) => s.reason), ['unknown-user']);
  assert.match(configured.skipped[0].detail, /^local;/);
});

// Final review (#58), finding 5: --apply re-checks against a freshly reloaded
// inventory, and an update dropped there is reported as skipped, not updated.
test('--apply reports an update dropped by the reload re-check as already-has-creator', async () => {
  const { addJob, run, inventoryPath } = setup();
  const id = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const stale = loadInventory(inventoryPath);
  // A creator appears on disk between planning and writing.
  const onDisk = loadInventory(inventoryPath);
  saveInventory(inventoryPath, {
    ...onDisk,
    guests: onDisk.guests.map((g) => (g.name === 'web-lxc' ? { ...g, creator: { username: 'admin', uid: ADMIN_UID } } : g)),
  });
  const report = await run({ apply: true, inventory: stale });
  assert.deepEqual(report.updates, []);
  assert.deepEqual(report.skipped.map((s) => [s.jobId, s.reason, s.detail]), [[id, 'already-has-creator', 'web-lxc']]);
  assert.deepEqual(creatorOf(inventoryPath, 'web-lxc'), { username: 'admin', uid: ADMIN_UID });
});

test('--apply reports an update dropped by the reload re-check as no-matching-guest when the guest is gone', async () => {
  const { addJob, run, inventoryPath } = setup();
  const id = addJob({ command: 'create-lxc', args: { host: 'pve1', mid: '4', hostname: 'web-lxc' } });
  const stale = loadInventory(inventoryPath);
  const onDisk = loadInventory(inventoryPath);
  saveInventory(inventoryPath, { ...onDisk, guests: onDisk.guests.filter((g) => g.name !== 'web-lxc') });
  const report = await run({ apply: true, inventory: stale });
  assert.deepEqual(report.updates, []);
  assert.deepEqual(report.skipped.map((s) => [s.jobId, s.reason, s.detail]), [[id, 'no-matching-guest', 'web-lxc on pve1, vmid 4004']]);
  assert.equal(loadInventory(inventoryPath).guests.some((g) => g.name === 'web-lxc'), false);
});

// Final review (#58), finding 6: the newest successful job decides the guest
// even when its user can't be resolved -- an older job by a known user never
// fills in for it.
test('a newer job by an unknown user wins the guest: no update, newer is unknown-user and older is superseded', async () => {
  const { addJob, run } = setup();
  const args = { host: 'pve1', mid: '4', hostname: 'web-lxc' };
  const older = addJob({ command: 'create-lxc', args, user: 'test-user' });
  const newer = addJob({ command: 'create-lxc', args, user: 'old-login' });
  const report = await run();
  assert.deepEqual(report.updates, []);
  assert.deepEqual(
    report.skipped.map((s) => [s.jobId, s.reason]),
    [
      [newer, 'unknown-user'],
      [older, 'superseded'],
    ]
  );
});
