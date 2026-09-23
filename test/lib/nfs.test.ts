import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNfsLines, parseMpEntries, nextFreeMpIndex, resolveNfsMountPath, buildNfsAttachScript } from '../../src/lib/nfs.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import type { Inventory, HostEntry } from '../../src/lib/inventory.ts';

const fstab = `
# comment line, ignored
UUID=abc / ext4 defaults 0 1
192.168.1.250:/volume1/media /mnt/media nfs defaults 0 0
192.168.1.250:/volume1/backup /mnt/backup nfs defaults 0 0
192.168.9.9:/other /mnt/other nfs defaults 0 0
`;

test('parseNfsLines extracts only nfs mounts from the given server, stripping the server prefix', () => {
  const result = parseNfsLines(fstab, '192.168.1.250');
  assert.deepEqual(result, [
    { exportPath: '/volume1/media', mountPoint: '/mnt/media' },
    { exportPath: '/volume1/backup', mountPoint: '/mnt/backup' },
  ]);
});

test('parseNfsLines returns an empty array when there are no matches', () => {
  assert.deepEqual(parseNfsLines('UUID=abc / ext4 defaults 0 1', '192.168.1.250'), []);
});

test('parseMpEntries extracts index, host path, and guest mount point from pct config lines', () => {
  const pctConfig = [
    'arch: amd64',
    'mp0: /mnt/pve/nas-media,mp=/mnt/media,backup=0',
    'mp2: local-lvm:vm-105-disk-1,mp=/data',
    'ostype: debian',
  ].join('\n');
  assert.deepEqual(parseMpEntries(pctConfig), [
    { index: 0, hostPath: '/mnt/pve/nas-media', mountPoint: '/mnt/media' },
    { index: 2, hostPath: 'local-lvm:vm-105-disk-1', mountPoint: '/data' },
  ]);
});

test('parseMpEntries returns an empty array when there are no mpN lines', () => {
  assert.deepEqual(parseMpEntries('arch: amd64\nostype: debian'), []);
});

test('nextFreeMpIndex returns 0 when nothing is used, and the first gap otherwise', () => {
  assert.equal(nextFreeMpIndex([]), 0);
  assert.equal(nextFreeMpIndex([{ index: 0, hostPath: 'a', mountPoint: '/a' }]), 1);
  assert.equal(
    nextFreeMpIndex([
      { index: 0, hostPath: 'a', mountPoint: '/a' },
      { index: 2, hostPath: 'b', mountPoint: '/b' },
    ]),
    1
  );
});

const nfsInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

test('resolveNfsMountPath resolves a fstab-based mount without any pvesh call', async () => {
  const host: HostEntry = {
    name: 'pve1',
    ssh_target: 'pve1.local',
    ssh_user: 'root',
    nfsMounts: [{ name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true }],
  };
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  const result = await resolveNfsMountPath(ssh, nfsInventory, host, 'nas-media');
  assert.equal(result, '/mnt/pve/nas-media');
  assert.equal(ssh.history.length, 0);
});

test('resolveNfsMountPath falls back to pvesh when no fstab mount matches', async () => {
  const host: HostEntry = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pvesh get /storage/nas-proxmox')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-proxmox' }), stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await resolveNfsMountPath(ssh, nfsInventory, host, 'nas-proxmox');
  assert.equal(result, '/mnt/pve/nas-proxmox');
});

test('resolveNfsMountPath throws when the storage lookup fails', async () => {
  const host: HostEntry = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  await assert.rejects(() => resolveNfsMountPath(ssh, nfsInventory, host, 'nope'), /Failed to look up storage 'nope' on pve1/);
});

test('resolveNfsMountPath throws when the storage has no path (not type nfs)', async () => {
  const host: HostEntry = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  const ssh = new FakeSSHClient(() => ({ stdout: JSON.stringify({}), stderr: '', code: 0 }));
  await assert.rejects(() => resolveNfsMountPath(ssh, nfsInventory, host, 'local-lvm'), /has no 'path' -- is it type 'nfs'/);
});

test('buildNfsAttachScript formats the pct set + pct reboot script', () => {
  const script = buildNfsAttachScript(105, 0, '/mnt/pve/nas-media', '/data');
  assert.equal(script, 'pct set 105 -mp0 /mnt/pve/nas-media,mp=/data\npct reboot 105');
});
