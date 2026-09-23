import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runAuditNfsMounts, formatAuditNfsMounts } from '../../src/commands/maintenance/audit-nfs-mounts.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      nfsMounts: [{ name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true }],
      storages: [{ name: 'nas-proxmox', type: 'nfs', content: ['backup'], active: true }],
    },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'backup-user', type: 'lxc', vmid: 106, host: 'pve1' },
    { name: 'clean', type: 'lxc', vmid: 107, host: 'pve1' },
    { name: 'dead', type: 'lxc', vmid: 108, host: 'pve1' },
    { name: 'not-lxc', type: 'vm', vmid: 109, host: 'pve1' },
  ],
};

function responder(pctConfigByVmid: Record<number, string>, failVmids: number[] = []) {
  return (_target: string, _user: string, cmd: string) => {
    const match = cmd.match(/^pct config (\d+)/);
    if (match) {
      const vmid = Number(match[1]);
      if (failVmids.includes(vmid)) throw new Error('connection refused');
      return { stdout: pctConfigByVmid[vmid] ?? '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

test('runAuditNfsMounts groups guests by their matched NFS mount and counts clean/unreachable containers', async () => {
  const ssh = new FakeSSHClient(
    responder(
      {
        105: 'mp0: /mnt/pve/nas-media,mp=/mnt/media,backup=0',
        106: 'mp0: /mnt/pve/nas-proxmox,mp=/backups',
        107: 'mp0: /mnt/pve/local-lvm,mp=/data',
      },
      [108]
    )
  );

  const result = await runAuditNfsMounts({}, { ssh, inventory });

  assert.equal(result.usages.length, 2);
  const media = result.usages.find((u) => u.name === 'nas-media')!;
  assert.equal(media.export, '/volume1/Media');
  assert.deepEqual(media.users, ['media (/mnt/media)']);
  const proxmox = result.usages.find((u) => u.name === 'nas-proxmox')!;
  assert.equal(proxmox.export, undefined, 'no export is known for a Proxmox-storage-backed match');
  assert.deepEqual(proxmox.users, ['backup-user (/backups)']);

  assert.equal(result.matchedCount, 2);
  assert.equal(result.cleanCount, 1, "'clean' has only an unrelated local-lvm bind-mount, not NFS-backed");
  assert.deepEqual(result.unreachable, [{ target: 'dead', error: 'connection refused' }]);
});

test('runAuditNfsMounts includes the underlying error in the unreachable warning', async () => {
  const ssh = new FakeSSHClient(responder({}, [108]));

  const { warnings } = await captureWarnings(() => runAuditNfsMounts({ host: 'dead' }, { ssh, inventory }));

  assert.ok(
    warnings.some((w) => w.includes('dead') && w.includes('connection refused')),
    `expected a warning naming the guest and its error, got: ${JSON.stringify(warnings)}`
  );
});

test('runAuditNfsMounts --host rejects a non-lxc guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runAuditNfsMounts({ host: 'not-lxc' }, { ssh, inventory }),
    /'not-lxc' is not an lxc guest/
  );
});

test('formatAuditNfsMounts renders a sorted report with the unreachable summary', () => {
  const output = formatAuditNfsMounts({
    usages: [
      { name: 'nas-media', export: '/volume1/Media', hostPath: '/mnt/pve/nas-media', users: ['media (/mnt/media)'] },
    ],
    matchedCount: 1,
    cleanCount: 1,
    unreachable: [{ target: 'dead', error: 'connection refused' }],
  });
  assert.match(output, /NFS shares in use, by mount:/);
  assert.match(output, /nas-media/);
  assert.match(output, /1 unreachable \(dead \(connection refused\)\)/);
});
