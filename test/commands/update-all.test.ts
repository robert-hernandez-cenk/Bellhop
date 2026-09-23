import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runUpdateAll, formatUpdateAll } from '../../src/commands/maintenance/update-all.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'apt-guest', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'apk-guest', type: 'lxc', vmid: 106, host: 'pve1' },
    { name: 'unknown-guest', type: 'lxc', vmid: 107, host: 'pve1' },
    { name: 'unreachable-guest', type: 'lxc', vmid: 108, host: 'pve1' },
    { name: 'broken-guest', type: 'lxc', vmid: 109, host: 'pve1' },
    { name: 'probe-broken-guest', type: 'lxc', vmid: 110, host: 'pve1' },
  ],
};

// runRemote wraps a guest command as `pct exec <vmid> -- sh -c '<command>'`,
// so the responder sees the whole wrapper. `command -v apt-get` appears only
// in the probe, which is what distinguishes a probe call from an update call.
function responder(_target: string, _user: string, cmd: string) {
  if (cmd.includes('pct exec 108')) throw new Error('connection refused');

  if (cmd.includes('command -v apt-get')) {
    if (cmd.includes('pct exec 106')) return { stdout: 'apk\n', stderr: '', code: 0 };
    if (cmd.includes('pct exec 107')) return { stdout: 'unknown\n', stderr: '', code: 0 };
    if (cmd.includes('pct exec 110')) return { stdout: '', stderr: 'sh: not found', code: 127 };
    return { stdout: 'apt\n', stderr: '', code: 0 };
  }

  if (cmd.includes('pct exec 109')) return { stdout: '', stderr: 'dpkg error', code: 1 };
  return { stdout: '', stderr: '', code: 0 };
}

test('runUpdateAll splits targets into pass / failConnect / failCommand / failUnknownPm', async () => {
  const ssh = new FakeSSHClient(responder);

  const result = await runUpdateAll({ group: 'lxc' }, { ssh, inventory });

  assert.deepEqual(result.pass, ['apt-guest', 'apk-guest']);
  assert.deepEqual(result.failConnect, [{ target: 'unreachable-guest', error: 'connection refused' }]);
  assert.deepEqual(result.failCommand, ['broken-guest', 'probe-broken-guest']);
  assert.deepEqual(result.failUnknownPm, ['unknown-guest']);
});

test('runUpdateAll logs the underlying connection error, not just the target name', async () => {
  const ssh = new FakeSSHClient(responder);

  const { warnings } = await captureWarnings(() => runUpdateAll({ host: 'unreachable-guest' }, { ssh, inventory }));

  assert.ok(
    warnings.some((w) => w.includes('unreachable-guest') && w.includes('connection refused')),
    `expected a warning naming the target and its error, got: ${JSON.stringify(warnings)}`
  );
});

test('runUpdateAll sends the apk command to an Alpine guest and never the apt command', async () => {
  const ssh = new FakeSSHClient(responder);

  await runUpdateAll({ host: 'apk-guest' }, { ssh, inventory });

  const sent = ssh.history.map((call) => call.command);
  assert.equal(sent.length, 2, 'one probe + one update');
  assert.match(sent[0], /command -v apt-get/);
  assert.match(sent[1], /apk update && apk upgrade/);
  assert.doesNotMatch(sent[1], /apt-get/);
});

test('runUpdateAll sends the apt command to a Debian guest', async () => {
  const ssh = new FakeSSHClient(responder);

  await runUpdateAll({ host: 'apt-guest' }, { ssh, inventory });

  const sent = ssh.history.map((call) => call.command);
  assert.equal(sent.length, 2, 'one probe + one update');
  assert.match(sent[1], /DEBIAN_FRONTEND=noninteractive apt-get update/);
  assert.match(sent[1], /--force-confold/);
});

test('runUpdateAll never attempts an update against a target whose package manager is unknown', async () => {
  const ssh = new FakeSSHClient(responder);

  const result = await runUpdateAll({ host: 'unknown-guest' }, { ssh, inventory });

  assert.deepEqual(result.failUnknownPm, ['unknown-guest']);
  assert.equal(ssh.history.length, 1, 'probe only -- no update attempted');
});

test('runUpdateAll counts a probe that exits nonzero as a command failure, not an unknown package manager', async () => {
  const ssh = new FakeSSHClient(responder);

  const result = await runUpdateAll({ host: 'probe-broken-guest' }, { ssh, inventory });

  assert.deepEqual(result.failCommand, ['probe-broken-guest']);
  assert.deepEqual(result.failUnknownPm, []);
  assert.equal(ssh.history.length, 1, 'probe only -- no update attempted');
});

test('runUpdateAll throws when no targets match', async () => {
  const emptyInventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runUpdateAll({ all: true }, { ssh, inventory: emptyInventory }), /No targets matched/);
});

test('formatUpdateAll renders the OK/failed/unknown summary', () => {
  const output = formatUpdateAll({ pass: ['a'], failConnect: [], failCommand: ['b'], failUnknownPm: ['c'] });
  assert.match(output, /OK: a/);
  assert.match(output, /Failed to connect: none/);
  assert.match(output, /Command failed: b/);
  assert.match(output, /Unknown package manager: c/);
});

test('formatUpdateAll lists each connection failure with its reason', () => {
  const output = formatUpdateAll({
    pass: [],
    failConnect: [{ target: 'pve1', error: 'All configured authentication methods failed' }],
    failCommand: [],
    failUnknownPm: [],
  });
  assert.match(output, /Failed to connect:\n {4}pve1: All configured authentication methods failed/);
});
