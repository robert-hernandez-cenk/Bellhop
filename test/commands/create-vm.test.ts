import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runCreateVm, buildCreateVmCommand } from '../../src/commands/provisioning/create-vm.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve2',
      ssh_target: 'pve2.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' },
      storages: [{ name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true }],
    },
  ],
  guests: [],
};

test('buildCreateVmCommand formats the qm create invocation without cloud-init', () => {
  const cmd = buildCreateVmCommand(
    { host: 'pve2', mid: 4, name: 'windows-test' },
    { vmid: 5004, ip: '192.168.2.4/16', gateway: '192.168.3.1' }
  );
  assert.equal(
    cmd,
    "qm create 5004 --name 'windows-test' --cores 2 --memory 2048 --net0 virtio,bridge='vmbr0' --scsi0 'local-lvm':20 --ipconfig0 ip='192.168.2.4/16',gw='192.168.3.1'"
  );
});

test('buildCreateVmCommand appends cloud-init flags when requested', () => {
  const cmd = buildCreateVmCommand(
    { host: 'pve2', mid: 4, name: 'windows-test', cloudInit: true },
    { vmid: 5004, ip: '192.168.2.4/16', gateway: '192.168.3.1' }
  );
  assert.match(cmd, /--ide2 'local-lvm':cloudinit --boot order=scsi0$/);
});

test('runCreateVm rejects an invalid --disk-storage', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCreateVm({ host: 'pve2', mid: 4, name: 'vm', diskStorage: 'bad storage' }, { ssh, inventory }),
    /--disk-storage must contain only/
  );
});

test('runCreateVm auto-picks a diskStorage from the host\'s scanned storages when none is given', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateVm({ host: 'pve2', mid: 4, name: 'windows-test' }, { ssh, inventory });
  assert.match(result.command, /--scsi0 'local-lvm':20/);
});

test('runCreateVm uses the operator-chosen diskStorage over the auto-picked one', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateVm({ host: 'pve2', mid: 4, name: 'windows-test', diskStorage: 'nas-proxmox' }, { ssh, inventory });
  assert.match(result.command, /--scsi0 'nas-proxmox':20/);
});

test('runCreateVm throws when the host has no active images storage scanned', async () => {
  const noStorageInventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCreateVm({ host: 'pve2', mid: 4, name: 'windows-test' }, { ssh, inventory: noStorageInventory }),
    /Host 'pve2' has no active storage supporting content type images/
  );
});

test('runCreateVm runs the command on the host when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateVm({ host: 'pve2', mid: 4, name: 'windows-test', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(result.mid.vmid, 5004);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve2.local');
});

test('runCreateVm throws when qm create exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'unable to create VM', code: 1 }));
  await assert.rejects(
    () => runCreateVm({ host: 'pve2', mid: 4, name: 'windows-test', apply: true }, { ssh, inventory }),
    /qm create failed on pve2 \(exit 1\): unable to create VM/
  );
});
