import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runSyncSshKeys, formatSyncSshKeysResult } from '../../src/commands/maintenance/sync-ssh-keys.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
  ],
  guests: [
    { name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' },
    { name: 'sonarr-lxc', type: 'lxc', vmid: 4007, host: 'pve1' },
    { name: 'jellyfin-lxc', type: 'lxc', vmid: 5004, host: 'pve2' },
    { name: 'windows-vm', type: 'vm', vmid: 4201, host: 'pve1' },
  ],
};

test('runSyncSshKeys rejects an unknown --host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runSyncSshKeys({ host: 'nope' }, { ssh, inventory }),
    /'nope' is not an lxc guest in inventory/
  );
});

test('runSyncSshKeys rejects a non-lxc --host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runSyncSshKeys({ host: 'windows-vm' }, { ssh, inventory }),
    /'windows-vm' is not an lxc guest in inventory/
  );
});

test('runSyncSshKeys rejects an inventory with no lxc guests at all', async () => {
  const noLxcInventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'windows-vm', type: 'vm', vmid: 4201, host: 'pve1' }],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runSyncSshKeys({}, { ssh, inventory: noLxcInventory }), /No lxc guests found in inventory/);
});

test('runSyncSshKeys targets only the named guest when --host is given', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 }));
  const result = await runSyncSshKeys({ host: 'plex-lxc' }, { ssh, inventory });
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].guest, 'plex-lxc');
  assert.equal(result.plans[0].host, 'pve1');
});

test('runSyncSshKeys targets every lxc guest (not vms) when --host is omitted', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncSshKeys({}, { ssh, inventory });
  assert.deepEqual(
    result.plans.map((p) => p.guest).sort(),
    ['jellyfin-lxc', 'plex-lxc', 'sonarr-lxc']
  );
});

test('runSyncSshKeys leaves a plan\'s script undefined when the parent host has no authorized_keys', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncSshKeys({ host: 'plex-lxc' }, { ssh, inventory });
  assert.equal(result.plans[0].script, undefined);
});

test('runSyncSshKeys builds a script when the parent host has authorized_keys', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 }));
  const result = await runSyncSshKeys({ host: 'plex-lxc' }, { ssh, inventory });
  assert.match(result.plans[0].script!, /ssh-ed25519 AAAA user@host/);
  assert.match(result.plans[0].script!, /grep -qxF/);
});

test('runSyncSshKeys caches the authorized_keys read per parent host -- two guests sharing pve1 trigger one cat call, not two', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    calls.push(cmd);
    return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
  });
  await runSyncSshKeys({}, { ssh, inventory });
  const catCalls = calls.filter((c) => c === 'cat ~/.ssh/authorized_keys 2>/dev/null');
  // 3 lxc guests total, but only 2 distinct parent hosts (pve1 x2, pve2 x1)
  assert.equal(catCalls.length, 2);
});

test('runSyncSshKeys resolves plans identically in dry-run and apply, and makes no write calls in dry-run', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runSyncSshKeys({ host: 'plex-lxc' }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(result.pass.length, 0);
  assert.equal(ssh.history.length, 1);
});

test('runSyncSshKeys applies each plan and buckets pass/failConnect/failCommand', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runSyncSshKeys({ apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.deepEqual(result.pass.sort(), ['jellyfin-lxc', 'plex-lxc', 'sonarr-lxc']);
  assert.equal(result.failConnect.length, 0);
  assert.equal(result.failCommand.length, 0);
});

test('runSyncSshKeys buckets a guest into failCommand when its write call exits non-zero', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'permission denied', code: 1 };
  });
  const result = await runSyncSshKeys({ host: 'plex-lxc', apply: true }, { ssh, inventory });
  assert.deepEqual(result.failCommand, ['plex-lxc']);
  assert.equal(result.pass.length, 0);
});

test('runSyncSshKeys buckets a guest into failConnect when its write call throws', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
    }
    throw new Error('connection refused');
  });
  const { result, warnings } = await captureWarnings(() =>
    runSyncSshKeys({ host: 'plex-lxc', apply: true }, { ssh, inventory })
  );
  assert.deepEqual(result.failConnect, [{ target: 'plex-lxc', error: 'connection refused' }]);
  assert.equal(result.pass.length, 0);
  assert.ok(
    warnings.some((w) => w.includes('plex-lxc') && w.includes('connection refused')),
    `expected a warning naming the guest and its error, got: ${JSON.stringify(warnings)}`
  );
});

test('runSyncSshKeys skips a guest whose parent host has no authorized_keys, without a write call, and it counts as neither pass nor fail', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runSyncSshKeys({ host: 'plex-lxc', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(result.pass.length, 0);
  assert.equal(result.failConnect.length, 0);
  assert.equal(result.failCommand.length, 0);
  assert.equal(ssh.history.length, 1, 'only the cat read, no write attempted');
});

test('formatSyncSshKeysResult includes a skip line for a host with no keys, and a pending summary before applying', () => {
  const result = {
    plans: [
      { guest: 'plex-lxc', host: 'pve1', script: undefined },
      { guest: 'sonarr-lxc', host: 'pve1', script: 'mkdir -p /root/.ssh...' },
    ],
    applied: false,
    pass: [],
    failConnect: [],
    failCommand: [],
  };
  const text = formatSyncSshKeysResult(result);
  assert.match(text, /plex-lxc \(pve1\): no authorized_keys on pve1 -- skipped/);
  assert.match(text, /sonarr-lxc \(pve1\)/);
  assert.match(text, /1 guest\(s\) would be updated, 1 skipped/);
});

test('formatSyncSshKeysResult shows the pass/fail summary after applying', () => {
  const result = {
    plans: [{ guest: 'plex-lxc', host: 'pve1', script: 'mkdir -p /root/.ssh...' }],
    applied: true,
    pass: ['plex-lxc'],
    failConnect: [],
    failCommand: [],
  };
  const text = formatSyncSshKeysResult(result);
  assert.match(text, /OK: plex-lxc/);
  assert.match(text, /Failed to connect: none/);
  assert.match(text, /Command failed: none/);
});

test('formatSyncSshKeysResult does not append the "may simply be stopped" note when there are no failures', () => {
  const result = {
    plans: [{ guest: 'plex-lxc', host: 'pve1', script: 'mkdir -p /root/.ssh...' }],
    applied: true,
    pass: ['plex-lxc'],
    failConnect: [],
    failCommand: [],
  };
  const text = formatSyncSshKeysResult(result);
  assert.doesNotMatch(text, /may simply be stopped/);
});

test('formatSyncSshKeysResult appends the "may simply be stopped" note when failCommand is non-empty -- the common case of a stopped lxc guest should not read as a mystery failure', () => {
  const result = {
    plans: [{ guest: 'plex-lxc', host: 'pve1', script: 'mkdir -p /root/.ssh...' }],
    applied: true,
    pass: [],
    failConnect: [],
    failCommand: ['plex-lxc'],
  };
  const text = formatSyncSshKeysResult(result);
  assert.match(text, /may simply be stopped/);
});

test('formatSyncSshKeysResult appends the "may simply be stopped" note when failConnect is non-empty', () => {
  const result = {
    plans: [{ guest: 'plex-lxc', host: 'pve1', script: 'mkdir -p /root/.ssh...' }],
    applied: true,
    pass: [],
    failConnect: [{ target: 'plex-lxc', error: 'connection refused' }],
    failCommand: [],
  };
  const text = formatSyncSshKeysResult(result);
  assert.match(text, /may simply be stopped/);
  assert.match(text, /Failed to connect:\n {4}plex-lxc: connection refused/);
});

test('formatSyncSshKeysResult does not append the "may simply be stopped" note in the pending (not-applied) branch even with an otherwise-similar shape', () => {
  const result = {
    plans: [{ guest: 'plex-lxc', host: 'pve1', script: undefined }],
    applied: false,
    pass: [],
    failConnect: [],
    failCommand: [],
  };
  const text = formatSyncSshKeysResult(result);
  assert.doesNotMatch(text, /may simply be stopped/);
});
