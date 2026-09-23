import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostEntry } from '../../src/lib/inventory.ts';
import { listBackupStorages } from '../../src/lib/storage.ts';

test('listBackupStorages returns only active storages supporting the backup content type', () => {
  const host: HostEntry = {
    name: 'pve1',
    ssh_target: 'pve1.local',
    ssh_user: 'root',
    storages: [
      { name: 'local', type: 'dir', content: ['vztmpl', 'backup'], active: true },
      { name: 'nas-proxmox', type: 'nfs', content: ['backup'], active: false },
      { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
    ],
  };
  assert.deepEqual(listBackupStorages(host), [
    { name: 'local', type: 'dir', content: ['vztmpl', 'backup'], active: true },
  ]);
});

test('listBackupStorages returns an empty list when the host has no storages', () => {
  const host: HostEntry = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.deepEqual(listBackupStorages(host), []);
});
