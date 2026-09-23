import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runGuestPower } from '../../src/commands/maintenance/guest-power.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'winbox', type: 'vm', vmid: 106, host: 'pve1' },
  ],
};

test('runGuestPower rejects an unknown/non-lxc/vm target name', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runGuestPower({ guest: 'pve1', state: 'start' }, { ssh, inventory }),
    /is not an lxc\/vm guest in inventory/
  );
  assert.equal(ssh.history.length, 0);
});

test('runGuestPower rejects an invalid state', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runGuestPower({ guest: 'media', state: 'reboot' as 'start' }, { ssh, inventory }),
    /--state must be 'start' or 'shutdown'/
  );
  assert.equal(ssh.history.length, 0);
});

test('runGuestPower does not call ssh when apply is not set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runGuestPower({ guest: 'media', state: 'start' }, { ssh, inventory });
  assert.equal(result.ran, false);
  assert.equal(result.command, 'pct start 105');
  assert.equal(ssh.history.length, 0);
});

test('runGuestPower runs pct start on the parent host for an lxc guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runGuestPower({ guest: 'media', state: 'start', apply: true }, { ssh, inventory });
  assert.equal(result.ran, true);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].command, 'pct start 105');
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
});

test('runGuestPower runs qm shutdown on the parent host for a vm guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runGuestPower({ guest: 'winbox', state: 'shutdown', apply: true }, { ssh, inventory });
  assert.equal(ssh.history[0].command, 'qm shutdown 106 --timeout 120');
});

test('runGuestPower surfaces a non-zero exit code from the remote command', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'CT is locked', code: 1 }));
  const result = await runGuestPower({ guest: 'media', state: 'start', apply: true }, { ssh, inventory });
  assert.equal(result.result?.code, 1);
  assert.equal(result.result?.stderr, 'CT is locked');
});
