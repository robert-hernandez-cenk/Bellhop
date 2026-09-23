import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runAttachNfsMount } from '../../src/commands/provisioning/attach-nfs-mount.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
};

function baseResponder(pctConfig: string) {
  return (target: string, user: string, cmd: string) => {
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    if (cmd === 'pct config 105') {
      return { stdout: pctConfig, stderr: '', code: 0 };
    }
    if (cmd.startsWith('pct set 105') || cmd.includes('pct reboot 105')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd.includes('mountpoint -q')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

test('runAttachNfsMount rejects an invalid storage id', async () => {
  const ssh = new FakeSSHClient(baseResponder(''));
  await assert.rejects(
    () => runAttachNfsMount({ guest: 'media', storage: 'bad id', mountPoint: '/data' }, { ssh, inventory }),
    /--storage must contain only/
  );
});

test('runAttachNfsMount rejects a relative mount point', async () => {
  const ssh = new FakeSSHClient(baseResponder(''));
  await assert.rejects(
    () => runAttachNfsMount({ guest: 'media', storage: 'nas-media', mountPoint: 'data' }, { ssh, inventory }),
    /--mount-point must be an absolute path/
  );
});

test('runAttachNfsMount refuses a duplicate bind-mount at the same path', async () => {
  const ssh = new FakeSSHClient(baseResponder('mp0: /mnt/pve/nas-media,mp=/data,backup=0\n'));
  await assert.rejects(
    () => runAttachNfsMount({ guest: 'media', storage: 'nas-media', mountPoint: '/data' }, { ssh, inventory }),
    /already has a bind-mount configured at \/data/
  );
});

test('runAttachNfsMount picks the next free mpN index and does not call ssh in dry run', async () => {
  const ssh = new FakeSSHClient(baseResponder('mp0: /mnt/pve/other,mp=/other\n'));
  const result = await runAttachNfsMount({ guest: 'media', storage: 'nas-media', mountPoint: '/data' }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.match(result.hostScript, /pct set 105 -mp1 \/mnt\/pve\/nas-media,mp=\/data/);
  assert.equal(ssh.history.length, 2); // storage lookup + pct config, no mutation
});

test('runAttachNfsMount applies the bind-mount and verifies the mount when apply is set', async () => {
  const ssh = new FakeSSHClient(baseResponder(''));
  const result = await runAttachNfsMount(
    { guest: 'media', storage: 'nas-media', mountPoint: '/data', apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 4);
  assert.match(ssh.history[2].command, /pct set 105 -mp0/);
  assert.match(ssh.history[3].command, /mountpoint -q/);
  assert.match(ssh.history[3].command, /\/data/);
});

const inventoryWithFstabMount: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      nfsMounts: [{ name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true }],
    },
  ],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
};

test('runAttachNfsMount resolves a fstab-based mount from inventory without any pvesh call', async () => {
  const ssh = new FakeSSHClient((target, user, cmd) => {
    if (cmd === 'pct config 105') return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runAttachNfsMount(
    { guest: 'media', storage: 'nas-media', mountPoint: '/data' },
    { ssh, inventory: inventoryWithFstabMount }
  );
  assert.equal(result.applied, false);
  assert.match(result.hostScript, /pct set 105 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
  assert.equal(ssh.history.length, 1, 'only the pct config read -- no pvesh lookup needed');
});

test('runAttachNfsMount falls back to pvesh when no fstab mount matches the given name', async () => {
  const ssh = new FakeSSHClient(baseResponder(''));
  const result = await runAttachNfsMount(
    { guest: 'media', storage: 'nas-media', mountPoint: '/data' },
    { ssh, inventory } // the plain `inventory` fixture has no nfsMounts at all
  );
  assert.equal(result.applied, false);
  assert.match(result.hostScript, /pct set 105 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
  assert.equal(ssh.history.length, 2, 'pvesh lookup + pct config, since nas-media is not in nfsMounts here');
});
