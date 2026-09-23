import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { getGuestStatuses } from '../../src/lib/guest-status.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root' },
  ],
  guests: [
    { name: 'plex', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'winbox', type: 'vm', vmid: 106, host: 'pve1' },
    { name: 'sonarr', type: 'lxc', vmid: 205, host: 'pve2' },
  ],
};

test('getGuestStatuses maps each guest name to its running/stopped status', async () => {
  const ssh = new FakeSSHClient((target, _user, cmd) => {
    if (cmd.includes('/lxc')) {
      if (target === 'pve1.local') return { stdout: JSON.stringify([{ vmid: 105, status: 'running' }]), stderr: '', code: 0 };
      if (target === 'pve2.local') return { stdout: JSON.stringify([{ vmid: 205, status: 'stopped' }]), stderr: '', code: 0 };
    }
    if (cmd.includes('/qemu')) {
      if (target === 'pve1.local') return { stdout: JSON.stringify([{ vmid: 106, status: 'stopped' }]), stderr: '', code: 0 };
      return { stdout: '[]', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });

  const result = await getGuestStatuses(ssh, inventory);
  assert.deepEqual(result.statuses, { plex: 'running', winbox: 'stopped', sonarr: 'stopped' });
  assert.deepEqual(result.failures, []);
});

test('getGuestStatuses records a host as failed and omits its guests, without affecting other hosts', async () => {
  const ssh = new FakeSSHClient((target, _user, cmd) => {
    if (target === 'pve1.local') throw new Error('connection refused');
    if (cmd.includes('/lxc')) return { stdout: JSON.stringify([{ vmid: 205, status: 'running' }]), stderr: '', code: 0 };
    return { stdout: '[]', stderr: '', code: 0 };
  });

  const result = await getGuestStatuses(ssh, inventory);
  assert.deepEqual(result.statuses, { sonarr: 'running' });
  assert.deepEqual(result.failures, ['pve1']);
});

test('getGuestStatuses treats a non-zero exit code the same as a thrown error', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'timeout', code: 1 }));
  const result = await getGuestStatuses(ssh, inventory);
  assert.deepEqual(result.statuses, {});
  assert.deepEqual(result.failures.sort(), ['pve1', 'pve2']);
});

test('getGuestStatuses discards all of a host\'s statuses if any per-type query fails', async () => {
  const ssh = new FakeSSHClient((target, _user, cmd) => {
    if (target === 'pve1.local') {
      if (cmd.includes('/lxc')) return { stdout: JSON.stringify([{ vmid: 105, status: 'running' }]), stderr: '', code: 0 };
      if (cmd.includes('/qemu')) return { stdout: '', stderr: 'query failed', code: 1 };
    }
    if (target === 'pve2.local') {
      if (cmd.includes('/lxc')) return { stdout: JSON.stringify([{ vmid: 205, status: 'stopped' }]), stderr: '', code: 0 };
      if (cmd.includes('/qemu')) return { stdout: '[]', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });

  const result = await getGuestStatuses(ssh, inventory);
  assert.deepEqual(result.statuses, { sonarr: 'stopped' });
  assert.deepEqual(result.failures, ['pve1']);
});
