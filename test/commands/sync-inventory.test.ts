import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runSyncInventory, formatSyncInventory } from '../../src/commands/maintenance/sync-inventory.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const baseInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50' },
    { name: 'gone', type: 'lxc', vmid: 199, host: 'pve1' },
  ],
};

function responderFor(config: {
  lxcList: unknown[];
  qemuList: unknown[];
  configByVmid: Record<number, unknown>;
  failLxc?: boolean;
  failQemu?: boolean;
  failConfigVmids?: number[];
  networkList?: unknown[];
  failNetwork?: boolean;
  storageList?: unknown[];
  failStorage?: boolean;
  hostFstab?: string;
  failFstab?: boolean;
  mountActive?: boolean;
}) {
  return (target: string, user: string, cmd: string) => {
    if (cmd.includes('/network --output-format json')) {
      if (config.failNetwork) throw new Error('connection refused');
      return { stdout: JSON.stringify(config.networkList ?? []), stderr: '', code: 0 };
    }
    if (cmd.includes('/storage --output-format json')) {
      if (config.failStorage) throw new Error('connection refused');
      return { stdout: JSON.stringify(config.storageList ?? []), stderr: '', code: 0 };
    }
    if (cmd.includes('/etc/fstab')) {
      if (config.failFstab) throw new Error('connection refused');
      return { stdout: config.hostFstab ?? '', stderr: '', code: 0 };
    }
    if (cmd.startsWith('mountpoint -q')) {
      return { stdout: '', stderr: '', code: config.mountActive === false ? 1 : 0 };
    }
    if (cmd.includes('/lxc --output-format json')) {
      if (config.failLxc) throw new Error('connection refused');
      return { stdout: JSON.stringify(config.lxcList), stderr: '', code: 0 };
    }
    if (cmd.includes('/qemu --output-format json')) {
      if (config.failQemu) throw new Error('connection refused');
      return { stdout: JSON.stringify(config.qemuList), stderr: '', code: 0 };
    }
    const configMatch = cmd.match(/\/(lxc|qemu)\/(\d+)\/config/);
    if (configMatch) {
      const vmid = Number(configMatch[2]);
      if (config.failConfigVmids?.includes(vmid)) throw new Error('connection timed out');
      return { stdout: JSON.stringify(config.configByVmid[vmid] ?? {}), stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

test('runSyncInventory reports a new guest and preserves an untouched one', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }, { vmid: 300, name: 'newbox', template: 0 }],
      qemuList: [],
      configByVmid: {
        105: { net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1' },
        300: { net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.60/24,gw=192.168.1.1' },
      },
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  assert.equal(result.newEntries.length, 1);
  assert.match(result.newEntries[0], /newbox/);
  const media = result.guests.find((g) => g.name === 'media');
  assert.equal(media?.ip, '192.168.1.50');
});

test('runSyncInventory preserves an existing guest\'s app slug', async () => {
  const inv: Inventory = {
    ...baseInventory,
    guests: [
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', app: 'plex' },
      { name: 'gone', type: 'lxc', vmid: 199, host: 'pve1' },
    ],
  };
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }],
      qemuList: [],
      configByVmid: {
        105: { net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1' },
      },
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: inv });

  const media = result.guests.find((g) => g.name === 'media');
  assert.equal(media?.app, 'plex');
});

test('runSyncInventory reports a removed guest that no longer appears live', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }],
      qemuList: [],
      configByVmid: { 105: { net0: 'ip=192.168.1.50/24' } },
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  assert.equal(result.removedEntries.length, 1);
  assert.match(result.removedEntries[0], /gone/);
  assert.ok(!result.guests.some((g) => g.name === 'gone'));
});

test('runSyncInventory keeps existing entries unchanged when the host query fails', async () => {
  const ssh = new FakeSSHClient(responderFor({ lxcList: [], qemuList: [], configByVmid: {}, failLxc: true }));

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  assert.equal(result.removedEntries.length, 0);
  assert.ok(result.guests.some((g) => g.name === 'gone'));
  assert.ok(result.guests.some((g) => g.name === 'media'));
});

test('runSyncInventory does not duplicate lxc guests when only the qemu query fails on the same host', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }],
      qemuList: [],
      configByVmid: { 105: { net0: 'ip=192.168.1.50/24' } },
      failQemu: true,
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const mediaEntries = result.guests.filter((g) => g.name === 'media');
  assert.equal(mediaEntries.length, 1, 'media should appear exactly once, not duplicated');
});

test('runSyncInventory preserves an existing guest ip when its per-guest config fetch fails', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }],
      qemuList: [],
      configByVmid: {},
      failConfigVmids: [105],
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const media = result.guests.find((g) => g.name === 'media');
  assert.equal(media?.ip, '192.168.1.50', 'a failed config fetch must not blank out a known-good ip');
});

test('formatSyncInventory renders the new/updated/removed summary', () => {
  const output = formatSyncInventory({
    guests: [],
    hosts: [],
    newEntries: ['newbox (type=lxc vmid=300 host=pve1 ip=\'192.168.1.60\')'],
    updatedEntries: [],
    removedEntries: ['gone (host=pve1 vmid=199)'],
    bridgeFailures: [],
    storageFailures: [],
    nfsMountFailures: [],
    nfsMountsSkipped: false,
  });
  assert.match(output, /New guests: 1/);
  assert.match(output, /\+ newbox/);
  assert.match(output, /Removed guests: 1/);
  assert.match(output, /- gone/);
});

test('runSyncInventory includes the underlying error in every per-query failure warning', async () => {
  const inventoryWithNfs: Inventory = { ...baseInventory, nfsServer: '198.51.100.10' };
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [{ vmid: 105, name: 'media', template: 0 }],
      qemuList: [],
      configByVmid: {},
      failNetwork: true,
      failStorage: true,
      failFstab: true,
      failQemu: true,
      failConfigVmids: [105],
    })
  );

  const { warnings } = await captureWarnings(() => runSyncInventory({}, { ssh, inventory: inventoryWithNfs }));

  for (const prefix of [
    'Failed to query network interfaces on pve1',
    'Failed to query storage pools on pve1',
    'Failed to query fstab NFS mounts on pve1',
    'Failed to query qemu list on pve1',
  ]) {
    assert.ok(
      warnings.some((w) => w.includes(prefix) && w.includes('connection refused')),
      `expected '${prefix}' warning to carry the error, got: ${JSON.stringify(warnings)}`
    );
  }
  assert.ok(
    warnings.some((w) => w.includes('Failed to fetch config for media') && w.includes('connection timed out')),
    `expected the config-fetch warning to carry the error, got: ${JSON.stringify(warnings)}`
  );
});

test('runSyncInventory includes stderr when a query runs but exits nonzero', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('/network --output-format json')) {
      return { stdout: '', stderr: 'no such node\n', code: 2 };
    }
    return { stdout: '[]', stderr: '', code: 0 };
  });

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  assert.deepEqual(result.bridgeFailures, [{ target: 'pve1', error: 'exit code 2: no such node' }]);
});

test('formatSyncInventory shows the reason next to each unreachable host', () => {
  const output = formatSyncInventory({
    guests: [],
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    newEntries: [],
    updatedEntries: [],
    removedEntries: [],
    bridgeFailures: [{ target: 'pve1', error: 'auth failed' }],
    storageFailures: [{ target: 'pve1', error: 'auth failed' }],
    nfsMountFailures: [{ target: 'pve1', error: 'auth failed' }],
    nfsMountsSkipped: false,
  });
  assert.match(output, /pve1: unreachable, bridges unchanged -- auth failed/);
  assert.match(output, /pve1: unreachable, storages unchanged -- auth failed/);
  assert.match(output, /pve1: unreachable, nfsMounts unchanged -- auth failed/);
});

test('runSyncInventory maps a bridge interface comment to alias, defaulting to LAN when unset', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      networkList: [
        { iface: 'vmbr0', type: 'bridge', active: 1, comments: '  Home LAN  ' },
        { iface: 'vmbr1', type: 'bridge', active: 0 },
        { iface: 'eth0', type: 'eth', active: 1, comments: 'uplink' },
      ],
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(host.bridges?.length, 2, 'only bridge-type interfaces should be kept');
  const vmbr0 = host.bridges!.find((b) => b.name === 'vmbr0')!;
  assert.equal(vmbr0.alias, 'Home LAN');
  assert.equal(vmbr0.active, true);
  const vmbr1 = host.bridges!.find((b) => b.name === 'vmbr1')!;
  assert.equal(vmbr1.alias, 'LAN');
  assert.equal(vmbr1.active, false);
});

test('runSyncInventory keeps a host\'s existing bridges unchanged when its network query fails', async () => {
  const inventoryWithBridges: Inventory = {
    ...baseInventory,
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', bridges: [{ name: 'vmbr0', alias: 'Old Alias', active: true }] },
    ],
  };
  const ssh = new FakeSSHClient(
    responderFor({ lxcList: [], qemuList: [], configByVmid: {}, failNetwork: true })
  );

  const result = await runSyncInventory({}, { ssh, inventory: inventoryWithBridges });

  assert.deepEqual(result.bridgeFailures, [{ target: 'pve1', error: 'connection refused' }]);
  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(host.bridges?.[0].alias, 'Old Alias', 'bridges must be left exactly as they were on failure');
});

test('runSyncInventory maps Proxmox storage entries, splitting content into a list and combining active+enabled', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      storageList: [
        { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', active: 1, enabled: 1 },
        { storage: 'local-lvm', type: 'lvmthin', content: 'rootdir,images', active: 1, enabled: 1 },
        { storage: 'stale-pool', type: 'lvmthin', content: 'rootdir,images', active: 0, enabled: 0 },
      ],
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(host.storages?.length, 3);
  const local = host.storages!.find((s) => s.name === 'local')!;
  assert.deepEqual(local.content, ['iso', 'vztmpl', 'backup']);
  assert.equal(local.active, true);
  const stale = host.storages!.find((s) => s.name === 'stale-pool')!;
  assert.equal(stale.active, false);
});

test('runSyncInventory carries a storage\'s reported total bytes, omitting it when Proxmox doesn\'t report one', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      storageList: [
        { storage: 'local-lvm', type: 'lvmthin', content: 'rootdir,images', active: 1, enabled: 1, total: 79456894976 },
        { storage: 'nas-proxmox', type: 'nfs', content: 'rootdir,images', active: 1, enabled: 1 },
      ],
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  const local = host.storages!.find((s) => s.name === 'local-lvm')!;
  assert.equal(local.totalBytes, 79456894976);
  const nas = host.storages!.find((s) => s.name === 'nas-proxmox')!;
  assert.equal(nas.totalBytes, undefined);
});

test('runSyncInventory drops storages with no content type install-app ever picks on (backup/iso/snippets-only)', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      storageList: [
        { storage: 'backup-target', type: 'dir', content: 'backup', active: 1, enabled: 1 },
        { storage: 'iso-only', type: 'dir', content: 'iso', active: 1, enabled: 1 },
        { storage: 'local-lvm', type: 'lvmthin', content: 'rootdir,images', active: 1, enabled: 1 },
      ],
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: baseInventory });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(
    host.storages?.map((s) => s.name),
    ['local-lvm'],
    'backup-target and iso-only support none of vztmpl/rootdir/images, so neither is ever a pickStorage candidate'
  );
});

test('runSyncInventory keeps a host\'s existing storages unchanged when its storage query fails', async () => {
  const inventoryWithStorages: Inventory = {
    ...baseInventory,
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        storages: [{ name: 'local', type: 'dir', content: ['vztmpl'], active: true }],
      },
    ],
  };
  const ssh = new FakeSSHClient(responderFor({ lxcList: [], qemuList: [], configByVmid: {}, failStorage: true }));

  const result = await runSyncInventory({}, { ssh, inventory: inventoryWithStorages });

  assert.deepEqual(result.storageFailures, [{ target: 'pve1', error: 'connection refused' }]);
  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(host.storages, [{ name: 'local', type: 'dir', content: ['vztmpl'], active: true }]);
});

test("runSyncInventory discovers a host's fstab-based NFS mounts, deriving the name from the mount point", async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      hostFstab: '198.51.100.10:/volume1/Media /mnt/pve/nas-media nfs defaults,_netdev,nofail 0 0',
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: { ...baseInventory, nfsServer: '198.51.100.10' } });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(host.nfsMounts, [
    { name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true },
  ]);
});

test('runSyncInventory marks a discovered fstab mount inactive when it is not currently mounted', async () => {
  const ssh = new FakeSSHClient(
    responderFor({
      lxcList: [],
      qemuList: [],
      configByVmid: {},
      hostFstab: '198.51.100.10:/volume1/Media /mnt/pve/nas-media nfs defaults 0 0',
      mountActive: false,
    })
  );

  const result = await runSyncInventory({}, { ssh, inventory: { ...baseInventory, nfsServer: '198.51.100.10' } });

  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(host.nfsMounts?.[0].active, false);
});

test("runSyncInventory keeps a host's existing nfsMounts unchanged when its fstab read fails", async () => {
  const inventoryWithNfsMounts: Inventory = {
    ...baseInventory,
    nfsServer: '198.51.100.10',
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        nfsMounts: [{ name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true }],
      },
    ],
  };
  const ssh = new FakeSSHClient(responderFor({ lxcList: [], qemuList: [], configByVmid: {}, failFstab: true }));

  const result = await runSyncInventory({}, { ssh, inventory: inventoryWithNfsMounts });

  assert.deepEqual(result.nfsMountFailures, [{ target: 'pve1', error: 'connection refused' }]);
  const host = result.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(host.nfsMounts, [{ name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true }]);
});

test('runSyncInventory skips the NFS scan when nfsServer is unset', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/network')) return { stdout: '[]', stderr: '', code: 0 };
    if (command.includes('/storage')) return { stdout: '[]', stderr: '', code: 0 };
    if (command.includes('fstab')) throw new Error('fstab must not be read when nfsServer is unset');
    return { stdout: '[]', stderr: '', code: 0 };
  });
  const result = await runSyncInventory({}, { ssh, inventory });
  assert.equal(result.nfsMountsSkipped, true);
  assert.ok(formatSyncInventory(result).includes('nfsServer is not set'));
});

test('runSyncInventory uses inventory.nfsServer when no option is passed', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    nfsServer: '10.0.0.5',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [],
  };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('fstab')) {
      return { stdout: '10.0.0.5:/volume1/media /mnt/media nfs defaults 0 0\n', stderr: '', code: 0 };
    }
    if (command.startsWith('mountpoint')) return { stdout: '', stderr: '', code: 0 };
    return { stdout: '[]', stderr: '', code: 0 };
  });
  const result = await runSyncInventory({}, { ssh, inventory });
  assert.equal(result.nfsMountsSkipped, false);
  assert.deepEqual(
    result.hosts[0].nfsMounts?.map((m) => m.export),
    ['/volume1/media']
  );
});
