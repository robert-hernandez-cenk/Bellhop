import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runPushSshKey, formatPushSshKeyResult } from '../../src/commands/maintenance/push-ssh-key.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
  guests: [
    { name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' },
    { name: 'sonarr-lxc', type: 'lxc', vmid: 4007, host: 'pve1' },
    { name: 'windows-vm', type: 'vm', vmid: 4201, host: 'pve1' },
  ],
};

test('runPushSshKey rejects an empty key', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runPushSshKey({ key: '  ', guests: ['plex-lxc'] }, { ssh, inventory }),
    /--key must not be empty/
  );
});

test('runPushSshKey rejects an empty guest list', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: [] }, { ssh, inventory }),
    /Specify at least one guest/
  );
});

test('runPushSshKey rejects an unknown guest', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: ['nope'] }, { ssh, inventory }),
    /'nope' is not an lxc guest in inventory/
  );
});

test('runPushSshKey rejects a non-lxc guest', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: ['windows-vm'] }, { ssh, inventory }),
    /'windows-vm' is not an lxc guest in inventory/
  );
});

test('runPushSshKey makes zero ssh calls in dry run', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  const result = await runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: ['plex-lxc', 'sonarr-lxc'] }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.deepEqual(result.targets, ['plex-lxc', 'sonarr-lxc']);
  assert.equal(ssh.history.length, 0);
});

test('runPushSshKey applies the ensure-present script to every named guest and buckets pass/failConnect/failCommand', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    assert.match(cmd, /grep -qxF/);
    assert.match(cmd, /ssh-ed25519 AAAA test/);
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runPushSshKey(
    { key: 'ssh-ed25519 AAAA test', guests: ['plex-lxc', 'sonarr-lxc'], apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.deepEqual(result.pass.sort(), ['plex-lxc', 'sonarr-lxc']);
  assert.equal(ssh.history.length, 2);
});

test('runPushSshKey trims leading/trailing whitespace off the key before embedding it in the generated script -- a key pasted with stray whitespace must not break idempotency on a later, untrimmed-typed run', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    // The heredoc body should contain the trimmed key on its own line, with
    // no leading/trailing spaces around it.
    assert.match(cmd, /^ssh-ed25519 AAAA test$/m);
    assert.doesNotMatch(cmd, /^ {2}ssh-ed25519 AAAA test/m);
    assert.doesNotMatch(cmd, /ssh-ed25519 AAAA test {2}$/m);
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runPushSshKey(
    { key: '  ssh-ed25519 AAAA test  ', guests: ['plex-lxc'], apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.deepEqual(result.pass, ['plex-lxc']);
  assert.equal(result.key, 'ssh-ed25519 AAAA test');
});

test('runPushSshKey buckets a guest into failCommand when its write call exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'permission denied', code: 1 }));
  const result = await runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: ['plex-lxc'], apply: true }, { ssh, inventory });
  assert.deepEqual(result.failCommand, ['plex-lxc']);
  assert.equal(result.pass.length, 0);
});

test('runPushSshKey buckets a guest into failConnect when its write call throws', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('connection refused');
  });
  const { result, warnings } = await captureWarnings(() =>
    runPushSshKey({ key: 'ssh-ed25519 AAAA test', guests: ['plex-lxc'], apply: true }, { ssh, inventory })
  );
  assert.deepEqual(result.failConnect, [{ target: 'plex-lxc', error: 'connection refused' }]);
  assert.equal(result.pass.length, 0);
  assert.ok(
    warnings.some((w) => w.includes('plex-lxc') && w.includes('connection refused')),
    `expected a warning naming the guest and its error, got: ${JSON.stringify(warnings)}`
  );
});

test('formatPushSshKeyResult lists each connection failure with its reason', () => {
  const text = formatPushSshKeyResult({
    key: 'ssh-ed25519 AAAA test',
    targets: ['plex-lxc'],
    applied: true,
    pass: [],
    failConnect: [{ target: 'plex-lxc', error: 'connection refused' }],
    failCommand: [],
  });
  assert.match(text, /Failed to connect:\n {4}plex-lxc: connection refused/);
});

test('formatPushSshKeyResult shows a preview line with the actual key before applying, so an operator can confirm they pasted the right key', () => {
  const text = formatPushSshKeyResult({
    key: 'ssh-ed25519 AAAA test',
    targets: ['plex-lxc', 'sonarr-lxc'],
    applied: false,
    pass: [],
    failConnect: [],
    failCommand: [],
  });
  assert.match(text, /Would ensure 'ssh-ed25519 AAAA test' present on: plex-lxc, sonarr-lxc/);
});

test('formatPushSshKeyResult shows the pass/fail summary after applying', () => {
  const text = formatPushSshKeyResult({
    key: 'ssh-ed25519 AAAA test',
    targets: ['plex-lxc'],
    applied: true,
    pass: ['plex-lxc'],
    failConnect: [],
    failCommand: [],
  });
  assert.match(text, /OK: plex-lxc/);
  assert.match(text, /Failed to connect: none/);
  assert.match(text, /Command failed: none/);
});
