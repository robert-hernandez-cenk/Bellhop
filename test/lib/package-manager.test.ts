import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROBE_COMMAND,
  UPDATE_COMMANDS,
  parsePackageManager,
  detectPackageManager,
  UnknownPackageManagerError,
} from '../../src/lib/package-manager.ts';
import type { Inventory } from '../../src/lib/inventory.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

// Shared by the detectPackageManager tests below -- a single lxc guest is
// enough, since detection itself doesn't care about target kind (that's
// runRemote's job, already covered by test/commands/update-all.test.ts).
const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
};

test('parsePackageManager recognizes each supported package manager', () => {
  assert.equal(parsePackageManager('apt\n'), 'apt');
  assert.equal(parsePackageManager('dnf\n'), 'dnf');
  assert.equal(parsePackageManager('apk\n'), 'apk');
  assert.equal(parsePackageManager('pacman\n'), 'pacman');
  assert.equal(parsePackageManager('zypper\n'), 'zypper');
});

test('parsePackageManager returns undefined for unknown, empty, or unrecognized output', () => {
  assert.equal(parsePackageManager('unknown\n'), undefined);
  assert.equal(parsePackageManager(''), undefined);
  assert.equal(parsePackageManager('   \n\n'), undefined);
  assert.equal(parsePackageManager('ok\n'), undefined);
  assert.equal(parsePackageManager('yum\n'), undefined);
});

// A `pve` host is reached by a direct SSH exec, which runs a login shell
// and can therefore emit a motd/banner ahead of the probe's own output.
test('parsePackageManager ignores a banner preceding the answer', () => {
  assert.equal(parsePackageManager('Welcome to Alpine!\nLast login: today\napk\n'), 'apk');
});

test('PROBE_COMMAND tests every supported package manager and falls back to unknown', () => {
  for (const binary of ['apt-get', 'dnf', 'apk', 'pacman', 'zypper']) {
    assert.match(PROBE_COMMAND, new RegExp(`command -v ${binary} `));
  }
  assert.match(PROBE_COMMAND, /else echo unknown; fi$/);
  // `yum` is deliberately absent: a yum-only RHEL 7-era guest should report
  // `unknown` rather than be silently handled by a compatibility shim.
  assert.doesNotMatch(PROBE_COMMAND, /command -v yum/);
});

test('UPDATE_COMMANDS keeps the apt command byte-identical to the previous hardcoded UPDATE_CMD', () => {
  assert.equal(
    UPDATE_COMMANDS.apt,
    'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade'
  );
});

test('UPDATE_COMMANDS runs every package manager non-interactively', () => {
  assert.equal(UPDATE_COMMANDS.dnf, 'dnf -y --refresh upgrade');
  assert.equal(UPDATE_COMMANDS.apk, 'apk update && apk upgrade');
  assert.equal(UPDATE_COMMANDS.pacman, 'pacman -Syu --noconfirm');
  // --gpg-auto-import-keys matters as much as --non-interactive here: alone,
  // --non-interactive auto-declines an unknown repo signing key, so a first
  // refresh after a repo is added fails rather than prompting.
  assert.equal(
    UPDATE_COMMANDS.zypper,
    'zypper --non-interactive --gpg-auto-import-keys refresh && zypper --non-interactive update'
  );
});

test('detectPackageManager returns detected when the probe reports a supported package manager', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'apk\n', stderr: '', code: 0 }));

  const result = await detectPackageManager(ssh, inventory, 'media');

  assert.deepEqual(result, { kind: 'detected', pm: 'apk' });
});

test('detectPackageManager returns unknown when the probe prints unknown', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'unknown\n', stderr: '', code: 0 }));

  const result = await detectPackageManager(ssh, inventory, 'media');

  assert.deepEqual(result, { kind: 'unknown' });
});

test('detectPackageManager returns unknown when the probe prints garbage', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'yum\n', stderr: '', code: 0 }));

  const result = await detectPackageManager(ssh, inventory, 'media');

  assert.deepEqual(result, { kind: 'unknown' });
});

test('detectPackageManager returns probe-failed with the probe\'s own ExecResult when it exits nonzero', async () => {
  const probeResult = { stdout: '', stderr: 'sh: not found', code: 127 };
  const ssh = new FakeSSHClient(() => probeResult);

  const result = await detectPackageManager(ssh, inventory, 'media');

  assert.deepEqual(result, { kind: 'probe-failed', result: probeResult });
});

test('detectPackageManager lets a runRemote connection failure propagate', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('connection refused');
  });

  await assert.rejects(() => detectPackageManager(ssh, inventory, 'media'), /connection refused/);
});

test('UnknownPackageManagerError is an Error naming the target twice, with the tried-list', () => {
  const err = new UnknownPackageManagerError('media');

  assert.ok(err instanceof Error);
  assert.equal(err.target, 'media');
  assert.equal(
    err.message,
    'No known package manager on media (tried apt-get, dnf, apk, pacman, zypper); install the packages on media by hand'
  );
});
