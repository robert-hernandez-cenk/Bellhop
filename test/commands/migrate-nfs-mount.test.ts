import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runMigrateNfsMount } from '../../src/commands/provisioning/migrate-nfs-mount.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  nfsServer: '198.51.100.10',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
};

function responder(opts: { fstab: string; storageExport: string; storagePath: string; pctConfig: string }) {
  return (target: string, user: string, cmd: string) => {
    if (cmd.includes('cat') && cmd.includes('/etc/fstab') && !cmd.includes('umount')) {
      return { stdout: opts.fstab, stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ export: opts.storageExport, path: opts.storagePath }), stderr: '', code: 0 };
    }
    if (cmd === 'pct config 105') return { stdout: opts.pctConfig, stderr: '', code: 0 };
    if (cmd.includes('pct set 105') || cmd.includes('pct reboot 105')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('umount') || cmd.includes('awk -v mp=')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('mountpoint -q')) return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected command: ${cmd}`);
  };
}

test('runMigrateNfsMount throws when the guest has no matching NFS mount', async () => {
  const ssh = new FakeSSHClient(
    responder({ fstab: 'UUID=abc / ext4 defaults 0 1', storageExport: '', storagePath: '', pctConfig: '' })
  );
  await assert.rejects(
    () => runMigrateNfsMount({ guest: 'media', storage: 'nas-media' }, { ssh, inventory }),
    /No NFS mount from 198\.51\.100\.10 found/
  );
});

test('runMigrateNfsMount refuses to proceed when the storage exports a different path', async () => {
  const ssh = new FakeSSHClient(
    responder({
      fstab: '198.51.100.10:/volume1/media /mnt/media nfs defaults 0 0',
      storageExport: '/volume1/other',
      storagePath: '/mnt/pve/nas-media',
      pctConfig: '',
    })
  );
  await assert.rejects(
    () => runMigrateNfsMount({ guest: 'media', storage: 'nas-media' }, { ssh, inventory }),
    /refusing to migrate \(wrong --storage\?\)/
  );
});

test('runMigrateNfsMount does not mutate anything in dry run', async () => {
  const ssh = new FakeSSHClient(
    responder({
      fstab: '198.51.100.10:/volume1/media /mnt/media nfs defaults 0 0',
      storageExport: '/volume1/media',
      storagePath: '/mnt/pve/nas-media',
      pctConfig: '',
    })
  );
  const result = await runMigrateNfsMount({ guest: 'media', storage: 'nas-media' }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.match(result.guestScript, /umount '\/mnt\/media'/);
  assert.match(result.hostScript, /pct set 105 -mp0 \/mnt\/pve\/nas-media,mp=\/mnt\/media/);
  assert.equal(ssh.history.length, 3); // fstab read + storage lookup + pct config, no mutation
});

test('runMigrateNfsMount tears down the direct mount and adds the bind-mount when apply is set', async () => {
  const ssh = new FakeSSHClient(
    responder({
      fstab: '198.51.100.10:/volume1/media /mnt/media nfs defaults 0 0',
      storageExport: '/volume1/media',
      storagePath: '/mnt/pve/nas-media',
      pctConfig: '',
    })
  );
  const result = await runMigrateNfsMount({ guest: 'media', storage: 'nas-media', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 6);
  assert.match(ssh.history[4].command, /pct set 105 -mp0/);
  assert.match(ssh.history[5].command, /mountpoint -q/);
});

test('runMigrateNfsMount throws when nfsServer is unset', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.10' }],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runMigrateNfsMount({ guest: 'media', storage: 'nas-proxmox' }, { ssh, inventory }),
    /nfsServer is not set/
  );
});
