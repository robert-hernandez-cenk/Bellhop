import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { runMigrateGuest, archiveLogPath } from '../../src/commands/provisioning/migrate-guest.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { NO_PROXY_SYNC_MESSAGE } from '../../src/lib/proxy/driver.ts';
import { withCapturedConsole } from '../../src/web/console-capture.ts';

test('archiveLogPath replaces the tar/vma + compression extension with .log', () => {
  assert.equal(
    archiveLogPath('/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar.zst'),
    '/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.log'
  );
  assert.equal(
    archiveLogPath('/mnt/pve/nas-proxmox/dump/vzdump-qemu-4020-2026_08_11-12_00_00.vma.gz'),
    '/mnt/pve/nas-proxmox/dump/vzdump-qemu-4020-2026_08_11-12_00_00.log'
  );
  // M1: a bare .tar/.vma with no compression suffix -- unreachable today
  // since --compress zstd is hardcoded, but the helper reads as
  // general-purpose, so it should still strip correctly rather than
  // silently leaving the compression-less extension in place.
  assert.equal(
    archiveLogPath('/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar'),
    '/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.log'
  );
  assert.equal(
    archiveLogPath('/mnt/pve/nas-proxmox/dump/vzdump-qemu-4020-2026_08_11-12_00_00.vma'),
    '/mnt/pve/nas-proxmox/dump/vzdump-qemu-4020-2026_08_11-12_00_00.log'
  );
});

const inventory: Inventory = {
  domain: 'example.com',
  backupStorage: 'nas-proxmox',
  // Set so every apply test that reaches full completion (see the 'media'
  // comment below) actually exercises runRenderStatusPage's read/write --
  // without it, that step is now a no-op skip (statusPagePath is opt-in as
  // of issue #124) and the responder's 'cat '/'set -e' branches would go
  // unused.
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [
    {
      name: 'pve-main',
      ssh_target: 'pve-main.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      // 'media' below always carries subdomains, so every apply test that
      // reaches full completion (not just an early-throw test) drives
      // runMigrateGuest into its final runSyncProxy/runRenderStatusPage
      // step -- same as recordProvisionedGuest/removeGuestEntry's real
      // production precedent, which never guards that call on a proxy host
      // actually existing. Without a 'proxy: true' entry here, those tests
      // would fail on "No inventory entry has 'proxy: true'" for a reason
      // unrelated to what they're actually testing (destroy/cleanup/
      // inventory rewrite).
      proxy: true,
      storages: [
        { name: 'local', type: 'dir', content: ['backup', 'iso', 'vztmpl'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
        { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'images', 'rootdir', 'vztmpl'], active: true },
      ],
    },
    {
      name: 'pve-secondary',
      ssh_target: 'pve-secondary.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' },
      storages: [
        { name: 'local', type: 'dir', content: ['backup', 'iso', 'vztmpl'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
        { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'images', 'rootdir', 'vztmpl'], active: true },
      ],
    },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 4012, host: 'pve-main', ip: '192.168.1.12', subdomains: ['media'], port: 8080 },
    { name: 'winbox', type: 'vm', vmid: 4020, host: 'pve-main', ip: '192.168.1.20' },
    { name: 'nordvpn-gw-lxc', type: 'lxc', vmid: 4030, host: 'pve-main', ip: '192.168.1.30', vpnGateway: 'nordvpn' },
  ],
};

function tempInventoryPath(): string {
  // Task 2 never reaches saveInventory (dry-run always returns before it),
  // so an intentionally-nonexistent path is fine here -- Task 4 replaces
  // this with a real mkdtempSync-backed fixture once saveInventory is
  // actually exercised.
  return '/unused-in-task-2';
}

test('runMigrateGuest rejects an unknown/non-lxc/vm guest name', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runMigrateGuest({ guest: 'nope', toHost: 'pve-secondary' }, { ssh, inventory, inventoryPath: tempInventoryPath() }),
    /'nope' is not an lxc\/vm guest in inventory/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects a backupStorage containing shell metacharacters', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', backupStorage: 'nas; rm -rf /' },
        { ssh, inventory, inventoryPath: tempInventoryPath() }
      ),
    /--backup-storage must contain only letters, digits, dots, hyphens, and underscores/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest throws when backupStorage is unset and no flag is given', async () => {
  const inv = isolatedInventory();
  delete inv.backupStorage;
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary' },
        { ssh, inventory: inv, inventoryPath: tempInventoryPath() }
      ),
    /backupStorage is not set -- run: bellhop set-config backupStorage <storage-id> --apply, or set it on the web UI's Settings page, or pass --backup-storage/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects an unknown target host', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runMigrateGuest({ guest: 'media', toHost: 'nope' }, { ssh, inventory, inventoryPath: tempInventoryPath() }),
    /Not a Proxmox host in inventory: nope/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects a same-host, same-vmid no-op (default --mid resolves to the current vmid)', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runMigrateGuest({ guest: 'media', toHost: 'pve-main' }, { ssh, inventory, inventoryPath: tempInventoryPath() }),
    /'media' is already vmid 4012 on 'pve-main' -- nothing to migrate/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects an explicit --mid that resolves to the same host and the same vmid', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-main', mid: 12 },
        { ssh, inventory, inventoryPath: tempInventoryPath() }
      ),
    /'media' is already vmid 4012 on 'pve-main' -- nothing to migrate/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest allows a same-host migration when --mid resolves to a different vmid (a renumber in place)', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('status')) return { stdout: '', stderr: '', code: 1 }; // free
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-main', mid: 50 },
    { ssh, inventory, inventoryPath: tempInventoryPath() }
  );
  assert.equal(result.applied, false);
  assert.deepEqual(result.mid, { vmid: 4050, ip: '192.168.1.50/16', gateway: '192.168.3.1' });
  assert.match(result.targetScript, /pct restore 4050 .* --storage local-lvm/);
});

test('runMigrateGuest rejects migrating a VPN gateway guest', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'nordvpn-gw-lxc', toHost: 'pve-secondary' },
        { ssh, inventory, inventoryPath: tempInventoryPath() }
      ),
    /'nordvpn-gw-lxc' is a VPN gateway \(vpnGateway: nordvpn\) -- refusing to migrate it/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects a backup storage that is not active/backup-capable/nfs-type on both hosts', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', backupStorage: 'local' },
        { ssh, inventory, inventoryPath: tempInventoryPath() }
      ),
    /--backup-storage 'local' must be an active, backup-capable, cluster-shared \('nfs'-type\) storage present on both 'pve-main' and 'pve-secondary'/
  );
  assert.equal(ssh.history.length, 0);
});

test('runMigrateGuest rejects when the derived target vmid is already in use', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('status')) return { stdout: '', stderr: '', code: 0 }; // "in use"
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () => runMigrateGuest({ guest: 'media', toHost: 'pve-secondary', mid: 12 }, { ssh, inventory, inventoryPath: tempInventoryPath() }),
    /VMID 5012 on 'pve-secondary' is already in use/
  );
});

test('runMigrateGuest dry run defaults --mid to the current vmid\'s numeric suffix and never mutates anything', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('status')) return { stdout: '', stderr: '', code: 1 }; // free
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runMigrateGuest({ guest: 'media', toHost: 'pve-secondary' }, { ssh, inventory, inventoryPath: tempInventoryPath() });
  assert.equal(result.applied, false);
  assert.deepEqual(result.mid, { vmid: 5012, ip: '192.168.2.12/16', gateway: '192.168.3.1' });
  assert.match(result.sourceScript, /vzdump 4012 --storage nas-proxmox --mode stop --compress zstd/);
  // Fix 1: the source guest is stopped again after backup if vzdump --mode
  // stop restarted it -- documented in the preview even though whether it's
  // actually needed can only be known live, at apply time.
  assert.match(result.sourceScript, /if still running.*pct stop 4012/);
  assert.match(result.sourceScript, /pct destroy 4012/);
  // Issue #53 US4: the permission copy runs after verification, before the
  // destroy, so the preview lists it between those two lines.
  assert.equal(
    result.sourceScript,
    [
      'vzdump 4012 --storage nas-proxmox --mode stop --compress zstd',
      '# then, if still running (vzdump --mode stop restarts a guest that was running before the backup): pct stop 4012',
      '# then, once the new guest is verified running on pve-secondary:',
      '# then copy any ACLs on /vms/4012 to /vms/5012',
      'pct destroy 4012',
    ].join('\n')
  );
  assert.match(result.targetScript, /pct restore 5012 .* --storage local-lvm/);
  // Fix 2: only ip= is ever rewritten -- the exact rewritten net0 value is
  // only known at apply time (it depends on reading the restored guest's
  // own config), so the preview shows a placeholder instead of a fabricated
  // command that would silently drop hwaddr=/tag=/etc. if taken literally.
  assert.match(result.targetScript, /pct set 5012 --net0 <ip= rewritten to 192.168.2.12\/16.*preserved/);
  assert.match(result.targetScript, /pct start 5012/);
  assert.equal(ssh.history.length, 1); // only the live checkVmidAvailable check
});

test('runMigrateGuest dry run honors an explicit --mid override', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', mid: 99 },
    { ssh, inventory, inventoryPath: tempInventoryPath() }
  );
  assert.deepEqual(result.mid, { vmid: 5099, ip: '192.168.2.99/16', gateway: '192.168.3.1' });
});

test('runMigrateGuest dry run uses qm for a vm guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  const result = await runMigrateGuest(
    { guest: 'winbox', toHost: 'pve-secondary' },
    { ssh, inventory, inventoryPath: tempInventoryPath() }
  );
  assert.match(result.sourceScript, /qm destroy 4020/);
  assert.match(result.sourceScript, /# then copy any ACLs on \/vms\/4020 to \/vms\/5020\nqm destroy 4020$/);
  assert.match(result.targetScript, /qm restore 5020 .* --storage local-lvm/);
  // The exact rewritten ipconfig0 value is only known at apply time (it
  // depends on reading the restored guest's own config) -- the preview
  // shows a placeholder describing the surgical ip=-only rewrite instead.
  assert.match(result.targetScript, /qm set 5020 --ipconfig0 <ip= rewritten to 192.168.2.20\/16.*preserved/);
  assert.match(result.targetScript, /qm start 5020/);
  assert.doesNotMatch(result.targetScript, /--net0/);
});

test('runMigrateGuest dry run accepts an explicit --backup-storage override', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', backupStorage: 'nas-proxmox' },
    { ssh, inventory, inventoryPath: tempInventoryPath() }
  );
  assert.equal(result.applied, false);
});

test('runMigrateGuest dry run uses pickStorage\'s automatic default (local-lvm) when --storage is not given', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  const result = await runMigrateGuest({ guest: 'media', toHost: 'pve-secondary' }, { ssh, inventory, inventoryPath: tempInventoryPath() });
  assert.match(result.targetScript, /--storage local-lvm/);
});

test('runMigrateGuest dry run honors an explicit --storage override for the target guest storage', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', storage: 'nas-proxmox' },
    { ssh, inventory, inventoryPath: tempInventoryPath() }
  );
  assert.match(result.targetScript, /pct restore 5012 .* --storage nas-proxmox/);
});

const VZDUMP_STDOUT =
  "INFO: starting new backup job: vzdump 4012 --storage nas-proxmox --mode stop --compress zstd\n" +
  "INFO: Starting Backup of VM 4012 (lxc)\n" +
  "INFO: creating vzdump archive '/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar.zst'\n" +
  'INFO: Finished Backup of VM 4012 (00:00:05)';

// A real net0 line for the *restored* guest's `pct config <newVmid>` --
// Fix 2's reconfigureGuestIp reads this, then rewrites only ip= before
// writing it back. Deliberately carries a gw=/hwaddr=/tag= that must all
// survive untouched, same as guest-vpn.test.ts's fixtures.
const RESTORED_NET0 =
  'net0: name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.12/16,tag=20,type=veth\n';
const RESTORED_IPCONFIG0 = 'ipconfig0: ip=192.168.1.20/16,gw=192.168.3.1\n';

function happyPathResponder(overrides: Record<string, { stdout: string; stderr: string; code: number }> = {}) {
  return (_target: string, _user: string, cmd: string) => {
    for (const [prefix, response] of Object.entries(overrides)) {
      if (cmd.startsWith(prefix)) return response;
    }
    if (cmd.includes('pvesh get /access/acl')) return { stdout: '[]\n', stderr: '', code: 0 }; // no permissions to copy
    if (cmd.startsWith('pct config') || cmd.startsWith('qm config')) {
      return { stdout: cmd.startsWith('pct') ? RESTORED_NET0 : RESTORED_IPCONFIG0, stderr: '', code: 0 };
    }
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable's pre-flight probe: free
    if (cmd.includes('status')) {
      // Every plain `pct status`/`qm status` call (the post-vzdump
      // source-guest check and the verify-running poll) reports a genuine,
      // successful "running" (exit 0, per I1: a real probe of an existing
      // guest always exits 0 regardless of running/stopped state) -- a
      // running source guest also exercises Fix 1's stop step, which the
      // write-command branch below handles.
      return { stdout: 'status: running', stderr: '', code: 0 };
    }
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct restore') || cmd.startsWith('qm restore')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.startsWith('pct set') || cmd.startsWith('qm set')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.startsWith('pct start') || cmd.startsWith('qm start')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.startsWith('pct stop') || cmd.startsWith('qm stop')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.startsWith('pct destroy') || cmd.startsWith('qm destroy')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected command: ${cmd}`);
  };
}

// checkVmidAvailable's own compound probe (`pct status N >/dev/null 2>&1 ||
// qm status N >/dev/null 2>&1`), Fix 1's post-vzdump source-guest status
// check (`pct status <sourceVmid>`), and the verify-running poll (`pct
// status <targetVmid>`) are all distinguishable by exact command text alone
// (the compound probe via its `>/dev/null` redirects, the other two via
// which vmid -- old vs. new -- they name), so this responds by exact
// matching rather than call-order counting. `sourceRunning` (default true)
// controls whether the post-vzdump check reports the source guest as still
// running, exercising Fix 1's stop step by default.
function orderedStatusResponder(sourceVmid: number, targetVmid: number, opts: { sourceRunning?: boolean } = {}) {
  const sourceRunning = opts.sourceRunning ?? true;
  return (_target: string, _user: string, cmd: string) => {
    if (cmd.includes('pvesh get /access/acl')) return { stdout: '[]\n', stderr: '', code: 0 }; // no permissions to copy
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable probe: free
    if (cmd === `pct status ${sourceVmid}` || cmd === `qm status ${sourceVmid}`) {
      return sourceRunning
        ? { stdout: 'status: running', stderr: '', code: 0 }
        : { stdout: 'status: stopped', stderr: '', code: 0 };
    }
    if (cmd === `pct status ${targetVmid}` || cmd === `qm status ${targetVmid}`) {
      return { stdout: 'status: running', stderr: '', code: 0 }; // verify-running poll: running immediately
    }
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config') || cmd.startsWith('qm config')) {
      return { stdout: cmd.startsWith('pct') ? RESTORED_NET0 : RESTORED_IPCONFIG0, stderr: '', code: 0 };
    }
    if (
      cmd.startsWith('pct restore') ||
      cmd.startsWith('qm restore') ||
      cmd.startsWith('pct set') ||
      cmd.startsWith('qm set') ||
      cmd.startsWith('pct start') ||
      cmd.startsWith('qm start') ||
      cmd.startsWith('pct stop') ||
      cmd.startsWith('qm stop') ||
      cmd.startsWith('pct destroy') ||
      cmd.startsWith('qm destroy') ||
      cmd.startsWith('rm -f') ||
      // sync-proxy's remote script and render-status-page's deployed
      // proxy-config read/write both run once 'media' (which always has
      // subdomains) finishes migrating and pve-main's 'proxy: true' entry
      // is found -- see the base inventory fixture's comment above.
      cmd.startsWith('cat ') ||
      cmd.startsWith('set -e')
    ) {
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

function isolatedInventory(): Inventory {
  return JSON.parse(JSON.stringify(inventory));
}

function tempSavedInventoryPath(inv: Inventory): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

test('runMigrateGuest apply backs up, stops the source guest, restores under the new vmid, reconfigures networking, starts, and verifies', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012));
  const inv = isolatedInventory();
  // As of Task 4, a successful apply reaches saveInventory -- this needs a
  // real writable path (same helper the Task 4 tests below use), not the
  // placeholder that sufficed back when Task 3 never reached that far.
  const invPath = tempSavedInventoryPath(inv);
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);

  const commands = ssh.history.map((c) => c.command);
  const targets = ssh.history.map((c) => c.sshTarget);
  // Ordered-sequence assertion: vmid-available probe (source-agnostic, sent
  // to the target host), vzdump on the source host, Fix 1's post-vzdump
  // source-guest status check + stop (source host, since orderedStatusResponder
  // defaults to reporting the source guest as still running), restore + a
  // Fix 2 config-read/net-rewrite pair + start on the target host, then the
  // verify-running poll (also target host).
  assert.equal(targets[0], 'pve-secondary.local'); // checkVmidAvailable
  assert.match(commands[0], /pct status 5012.*qm status 5012/);
  assert.equal(targets[1], 'pve-main.local'); // vzdump
  assert.match(commands[1], /^vzdump 4012 --storage nas-proxmox --mode stop --compress zstd$/);
  assert.equal(targets[2], 'pve-main.local'); // Fix 1: post-vzdump source status check
  assert.equal(commands[2], 'pct status 4012');
  assert.equal(targets[3], 'pve-main.local'); // Fix 1: source guest is stopped
  assert.equal(commands[3], 'pct stop 4012');
  assert.equal(targets[4], 'pve-secondary.local'); // restore
  assert.match(commands[4], /^pct restore 5012 '\/mnt\/pve\/nas-proxmox\/dump\/vzdump-lxc-4012-2026_08_11-12_00_00\.tar\.zst' --storage local-lvm$/);
  assert.equal(targets[5], 'pve-secondary.local'); // Fix 2: read the restored guest's config
  assert.equal(commands[5], 'pct config 5012');
  assert.equal(targets[6], 'pve-secondary.local'); // Fix 2: surgical ip=-only net0 rewrite
  assert.equal(
    commands[6],
    "pct set 5012 --net0 'name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.2.12/16,tag=20,type=veth'"
  );
  assert.equal(targets[7], 'pve-secondary.local'); // start
  assert.equal(commands[7], 'pct start 5012');
  assert.equal(targets[8], 'pve-secondary.local'); // verify poll (first check)
  assert.equal(commands[8], 'pct status 5012');
});

test('runMigrateGuest apply throws and never reaches restore when stopping the still-running source guest fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable: free
    if (cmd === 'pct status 4012') return { stdout: 'status: running', stderr: '', code: 0 }; // source still running
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd === 'pct stop 4012') return { stdout: '', stderr: 'container is locked', code: 1 };
    if (cmd.startsWith('pct restore')) throw new Error('restore must never run while the source guest might still be running');
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-in-this-test' }
      ),
    /Failed to stop 'media'.*pve-main.*container is locked/
  );
});

test('runMigrateGuest apply throws and never reaches restore when the post-backup source status probe itself fails', async () => {
  // I1: the probe returning a non-zero exit code with ambiguous/empty
  // stdout must not be silently read as "not running" -- if we can't prove
  // the source guest is stopped, we must not proceed to restore.
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable: free
    if (cmd === 'pct status 4012') return { stdout: '', stderr: 'unable to get PID for CT 4012', code: 2 }; // probe itself failed
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct restore')) throw new Error('restore must never run when the source status probe fails');
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-in-this-test' }
      ),
    /Failed to (check|determine) whether 'media'.*(is )?(still )?running.*pve-main.*exit 2/
  );
});

test('runMigrateGuest apply skips the stop step when the source guest already reports stopped after backup', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012, { sourceRunning: false }));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);
  const commands = ssh.history.map((c) => c.command);
  assert.ok(!commands.includes('pct stop 4012'), 'stop must never be sent when the source guest already reports stopped');
});

test('runMigrateGuest apply preserves a non-default gw= (e.g. a VPN-gateway-routed guest) when rewriting net0', async () => {
  const vpnRoutedNet0 = 'net0: name=eth0,bridge=vmbr0,gw=192.168.1.30,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.12/16,type=veth\n';
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable: free
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // source already stopped
    if (cmd === 'pct status 5012') return { stdout: 'status: running', stderr: '', code: 0 }; // verify poll
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config')) return { stdout: vpnRoutedNet0, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  const commands = ssh.history.map((c) => c.command);
  const netCommand = commands.find((c) => c.startsWith('pct set'));
  // gw= must be the guest's own VPN-gateway IP, not resolveMid's LAN
  // gateway (192.168.3.1) -- silently resetting it would un-VPN the guest.
  assert.ok(netCommand?.includes('gw=192.168.1.30'), `expected gw=192.168.1.30 to survive untouched, got: ${netCommand}`);
  assert.ok(netCommand?.includes('ip=192.168.2.12/16'), `expected ip= rewritten to the new host's IP, got: ${netCommand}`);
});

test('runMigrateGuest apply throws a clear error when the restored guest has no net0 in its config', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable: free
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 };
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config')) return { stdout: 'arch: amd64\nostype: debian', stderr: '', code: 0 }; // no net0 line
    if (cmd.startsWith('pct destroy')) throw new Error('destroy must never be called');
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-in-this-test' }
      ),
    /Restored guest vmid 5012 on pve-secondary has no net0 in its config.*the original guest on pve-main is stopped \(not destroyed\).*pct start 4012/
  );
});

test('runMigrateGuest apply throws when the post-restore start fails, telling the operator the source guest is stopped (not untouched)', async () => {
  const ssh = new FakeSSHClient(
    happyPathResponder({ 'pct start': { stdout: '', stderr: 'no space left on device', code: 1 } })
  );
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-in-this-test' }
      ),
    /pct start failed for vmid 5012 on pve-secondary \(exit 1\).*the original guest on pve-main is stopped \(not destroyed\).*pct start 4012/
  );
});

test('runMigrateGuest apply rewrites only ip= in ipconfig0 for a VM guest, preserving gw=', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4020, 5020, { sourceRunning: false }));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'winbox', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  const commands = ssh.history.map((c) => c.command);
  const configReadCommand = commands.find((c) => c.startsWith('qm config'));
  assert.equal(configReadCommand, 'qm config 5020');
  const netCommand = commands.find((c) => c.startsWith('qm set'));
  assert.equal(netCommand, "qm set 5020 --ipconfig0 'ip=192.168.2.20/16,gw=192.168.3.1'");
});

test('runMigrateGuest apply uses an explicit --storage override for the restore command instead of pickStorage\'s default', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012, { sourceRunning: false }));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', storage: 'nas-proxmox', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  const commands = ssh.history.map((c) => c.command);
  const restoreCommand = commands.find((c) => c.startsWith('pct restore'));
  assert.match(restoreCommand ?? '', /--storage nas-proxmox$/);
});

test('runMigrateGuest apply throws and touches nothing on the target host when vzdump fails', async () => {
  const ssh = new FakeSSHClient(
    happyPathResponder({ vzdump: { stdout: '', stderr: 'vzdump failed', code: 1 } })
  );
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-until-task-4' }
      ),
    /vzdump failed on pve-main \(exit 1\)/
  );
  const commands = ssh.history.map((c) => c.command);
  assert.ok(!commands.some((c) => c.startsWith('pct restore')), 'restore must never run after a failed backup');
});

test('runMigrateGuest apply throws a clear error when vzdump succeeds but its archive path cannot be parsed', async () => {
  const ssh = new FakeSSHClient(
    happyPathResponder({ vzdump: { stdout: 'INFO: something unexpected, no archive line', stderr: '', code: 0 } })
  );
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-until-task-4' }
      ),
    /Could not find the created archive path in vzdump's output on pve-main/
  );
});

test('runMigrateGuest apply throws when restore fails, telling the operator the source guest is stopped (not untouched)', async () => {
  const ssh = new FakeSSHClient(
    happyPathResponder({ 'pct restore': { stdout: '', stderr: 'no space left', code: 1 } })
  );
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-until-task-4' }
      ),
    // I2: by the time restore runs, Fix 1's post-vzdump status check has
    // already stopped the source guest (or found it already stopped) --
    // the old "is untouched on pve-main" wording is misleading and must be
    // replaced with wording that says it's stopped and how to restart it.
    /pct restore failed on pve-secondary \(exit 1\).*the original guest on pve-main is stopped \(not destroyed\).*pct start 4012/
  );
});

test('runMigrateGuest apply retries the verify-running poll before giving up', async () => {
  const sleeps: number[] = [];
  let pollCalls = 0;
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable: free
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // source already stopped -- Fix 1 no-op
    if (cmd === 'pct status 5012') {
      pollCalls += 1;
      // verify-running poll: not running for the first 2 checks, then running
      return pollCalls < 3 ? { stdout: 'status: stopped', stderr: '', code: 0 } : { stdout: 'status: running', stderr: '', code: 0 };
    }
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config')) return { stdout: RESTORED_NET0, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  // Same reasoning as the previous test -- this apply now reaches
  // saveInventory, so it needs a real writable path.
  const invPath = tempSavedInventoryPath(inv);
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async (ms) => void sleeps.push(ms) },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);
  assert.equal(sleeps.length, 2, 'should sleep once between each of the 2 non-running polls before the 3rd succeeds');
});

test('runMigrateGuest apply throws after exhausting the verify-running retry budget, and never destroys the source guest', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable probe: free
    // I1: a genuine `pct status <vmid>` probe of an existing guest reports
    // exit 0 regardless of running/stopped -- Fix 1's source-guest check
    // must see a real, successful "stopped" report here, not a bare
    // non-zero exit (that's the "probe itself failed" case, covered by its
    // own dedicated test above).
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // source already stopped
    if (cmd === 'pct status 5012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // verify poll: never reports running
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config')) return { stdout: RESTORED_NET0, stderr: '', code: 0 };
    if (cmd.startsWith('pct destroy')) throw new Error('destroy must never be called when verification fails');
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  await assert.rejects(
    () =>
      runMigrateGuest(
        { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
        { ssh, inventory: inv, inventoryPath: '/unused-until-task-4' }
      ),
    // I2: the timeout message must also tell the operator the source guest
    // is stopped (not "left untouched") and how to restart it.
    /never reported running after 10 attempt\(s\).*the original guest on pve-main is stopped \(not destroyed\).*pct start 4012/
  );
});

test('runMigrateGuest apply destroys the original guest and cleans up the backup archive after verification', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );

  const commands = ssh.history.map((c) => c.command);
  const targets = ssh.history.map((c) => c.sshTarget);
  const destroyIdx = commands.findIndex((c) => c === 'pct destroy 4012');
  assert.ok(destroyIdx > -1, 'the original guest must be destroyed');
  assert.equal(targets[destroyIdx], 'pve-main.local', 'destroy must run on the SOURCE host, against the OLD vmid');

  const cleanupIdx = commands.findIndex((c) => c.startsWith('rm -f'));
  assert.ok(cleanupIdx > -1, 'the backup archive must be cleaned up');
  assert.equal(targets[cleanupIdx], 'pve-main.local');
  // Fix 5: vzdump's .log sidecar *replaces* the archive's .tar.zst
  // extension rather than appending onto it -- only .notes genuinely
  // appends.
  assert.match(
    commands[cleanupIdx],
    /^rm -f '\/mnt\/pve\/nas-proxmox\/dump\/vzdump-lxc-4012-2026_08_11-12_00_00\.tar\.zst' '\/mnt\/pve\/nas-proxmox\/dump\/vzdump-lxc-4012-2026_08_11-12_00_00\.tar\.zst\.notes' '\/mnt\/pve\/nas-proxmox\/dump\/vzdump-lxc-4012-2026_08_11-12_00_00\.log'$/
  );
});

test('runMigrateGuest never destroys the source guest when verification fails, and inventory is untouched', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    // Exact match, not startsWith -- see the equivalent comment in Task 3's
    // "exhausts verify-running retry budget" test for why startsWith would
    // misclassify checkVmidAvailable's own compound probe command here.
    if (cmd.startsWith('pct status') && cmd.includes('>/dev/null')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable probe: free
    // I1: the source-guest status check needs a genuine successful "stopped"
    // report (exit 0), not a bare non-zero exit -- see the dedicated
    // "post-backup source status probe itself fails" test for that case.
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // source already stopped
    if (cmd === 'pct status 5012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // never running
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct config')) return { stdout: RESTORED_NET0, stderr: '', code: 0 };
    if (cmd.startsWith('pct destroy')) throw new Error('destroy must never be called');
    if (cmd.startsWith('rm -f')) throw new Error('cleanup must never be called');
    return { stdout: '', stderr: '', code: 0 };
  });
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await assert.rejects(() =>
    runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    )
  );
  const saved = loadInventory(invPath);
  const guest = saved.guests.find((g) => g.name === 'media');
  assert.equal(guest?.host, 'pve-main', 'inventory must be untouched when verification fails');
  assert.equal(guest?.vmid, 4012);
});

test('runMigrateGuest apply rewrites host/vmid/ip in inventory, preserving name/type/subdomains/port', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );

  const saved = loadInventory(invPath);
  const guest = saved.guests.find((g) => g.name === 'media');
  assert.ok(guest, 'guest must still be present under the same name');
  assert.equal(guest?.host, 'pve-secondary');
  assert.equal(guest?.vmid, 5012);
  assert.equal(guest?.ip, '192.168.2.12');
  assert.equal(guest?.type, 'lxc');
  assert.deepEqual(guest?.subdomains, ['media']);
  assert.equal(guest?.port, 8080);

  // In-memory inventory object handed in must also reflect the change, same
  // as recordProvisionedGuest/deploy-vpn-gateway's precedent -- callers that
  // hold a reference to the same object (e.g. the web server's shared
  // in-memory inventory) see the update without a reload.
  const inMemoryGuest = inv.guests.find((g) => g.name === 'media');
  assert.equal(inMemoryGuest?.host, 'pve-secondary');
});

// T025 (issue #58, US2): migrate-guest's inventory rewrite spreads the
// existing guest entry (`{ ...g, host, vmid, ip }`), so a recorded creator
// must survive the host move/renumber the same way name/type/subdomains/
// port already do above.
test("runMigrateGuest apply preserves a guest's recorded creator across a successful migration", async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012));
  const inv = isolatedInventory();
  const media = inv.guests.find((g) => g.name === 'media')!;
  media.creator = { uid: 'uid-test-user', username: 'test-user' };
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );

  const saved = loadInventory(invPath);
  const guest = saved.guests.find((g) => g.name === 'media');
  assert.deepEqual(guest?.creator, { uid: 'uid-test-user', username: 'test-user' });

  const inMemoryGuest = inv.guests.find((g) => g.name === 'media');
  assert.deepEqual(inMemoryGuest?.creator, { uid: 'uid-test-user', username: 'test-user' });
});

test('runMigrateGuest apply renumbers a guest in place on the same host (backup/restore under a new vmid, then destroys the old one)', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 4050));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-main', mid: 50, apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);

  const commands = ssh.history.map((c) => c.command);
  const targets = ssh.history.map((c) => c.sshTarget);
  // Every step -- backup, restore, destroy -- targets the same physical
  // host ('pve-main.local') since source and target host are literally the
  // same entry; only the vmid changes.
  assert.ok(targets.every((t) => t === 'pve-main.local'), 'every step must target the source/target host, they are the same host');
  assert.ok(commands.some((c) => c === 'pct restore 4050 \'/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar.zst\' --storage local-lvm'));
  assert.ok(commands.some((c) => c === 'pct destroy 4012'), 'the original vmid must still be destroyed once the new one verifies running');

  const saved = loadInventory(invPath);
  const guest = saved.guests.find((g) => g.name === 'media');
  assert.equal(guest?.host, 'pve-main');
  assert.equal(guest?.vmid, 4050);
  assert.equal(guest?.ip, '192.168.1.50');
});

test('runMigrateGuest apply re-syncs the proxy when the migrated guest has subdomains', async () => {
  const proxyCalls: string[] = [];
  // Must be created once, outside the FakeSSHClient callback -- it tracks
  // status-call count across calls to distinguish checkVmidAvailable's probe
  // from the later verify-running poll (see its own doc comment above).
  // Calling the factory fresh on every invocation would reset that counter
  // each time and every status call would look like "the first one".
  const respondStatus = orderedStatusResponder(4012, 5012);
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('BEGIN bellhop-managed') || cmd.includes('Caddyfile') || cmd.includes('caddy')) {
      proxyCalls.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    }
    return respondStatus(_t, _u, cmd) as { stdout: string; stderr: string; code: number };
  });
  const inv: Inventory = {
    ...isolatedInventory(),
    hosts: isolatedInventory().hosts.map((h) => (h.name === 'pve-main' ? { ...h, proxy: true } : h)),
  };
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.ok(proxyCalls.some((c) => c.includes('BEGIN bellhop-managed')), 'the managed proxy block must be regenerated');
});

test('runMigrateGuest apply still syncs the proxy but skips the status page when statusPagePath is unset', async () => {
  const proxyCalls: string[] = [];
  const respondStatus = orderedStatusResponder(4012, 5012);
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.includes('BEGIN bellhop-managed') || cmd.includes('Caddyfile') || cmd.includes('caddy')) {
      proxyCalls.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    }
    return respondStatus(_t, _u, cmd) as { stdout: string; stderr: string; code: number };
  });
  const inv: Inventory = {
    ...isolatedInventory(),
    hosts: isolatedInventory().hosts.map((h) => (h.name === 'pve-main' ? { ...h, proxy: true } : h)),
  };
  delete inv.statusPagePath;
  const invPath = tempSavedInventoryPath(inv);
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);
  assert.ok(proxyCalls.some((c) => c.includes('BEGIN bellhop-managed')), 'the managed proxy block is still regenerated');
  // render-status-page's read is an exact 'cat /etc/caddy/Caddyfile' and its
  // write script always contains its 'STATUS_PAGE_EOF' heredoc terminator --
  // distinct markers from sync-proxy's own 'cat'-using remote script, which
  // this test's other 'BEGIN bellhop-managed' assertion already confirms
  // still ran.
  assert.ok(!proxyCalls.some((c) => c === 'cat /etc/caddy/Caddyfile' || c.includes('STATUS_PAGE_EOF')), 'the status page read/write must be skipped');
});

test('runMigrateGuest apply does not touch the proxy for a guest with no subdomains', async () => {
  const ssh = new FakeSSHClient(orderedStatusResponder(4020, 5020));
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  await runMigrateGuest(
    { guest: 'winbox', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  const commands = ssh.history.map((c) => c.command);
  assert.ok(!commands.some((c) => c.includes('Caddyfile') || c.includes('BEGIN bellhop-managed')));
});

test('runMigrateGuest apply warns but does not throw when destroying the original guest fails post-verification', async () => {
  const warnings: string[] = [];
  const originalWarn = console.error;
  console.error = (msg: string) => warnings.push(String(msg));
  try {
    // Same reasoning as the previous test -- create the stateful responder
    // once, not fresh per call.
    const respondStatus = orderedStatusResponder(4012, 5012);
    const ssh = new FakeSSHClient((_t, _u, cmd) => {
      if (cmd.startsWith('pct destroy')) return { stdout: '', stderr: 'in use', code: 1 };
      return respondStatus(_t, _u, cmd) as { stdout: string; stderr: string; code: number };
    });
    const inv = isolatedInventory();
    const invPath = tempSavedInventoryPath(inv);
    const result = await runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    );
    assert.equal(result.applied, true, 'the migration itself must still count as successful');
    const saved = loadInventory(invPath);
    assert.equal(saved.guests.find((g) => g.name === 'media')?.host, 'pve-secondary', 'inventory must still be updated');
    assert.ok(warnings.some((w) => w.includes('clean it up by hand')));
  } finally {
    console.error = originalWarn;
  }
});

// Issue #33 US2: under proxyDriver: 'none' (no 'proxy: true' entry at all --
// the base fixture's 'pve-main' host has none by default, unlike the
// 'proxy: true' tests above that add one), migrating a guest with
// subdomains must still complete cleanly: sync-proxy's own early return
// means no proxy-host SSH call is ever attempted, and the status-page skip
// line -- not a "proxy sync failed" warning -- is what gets logged.
test("runMigrateGuest apply completes cleanly under proxyDriver 'none', with no proxy-host SSH calls and no 'proxy sync failed' warning", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const originalWarn = console.error;
  const originalLog = console.log;
  console.error = (msg: string) => warnings.push(String(msg));
  console.log = (msg: string) => infos.push(String(msg));
  try {
    const respondStatus = orderedStatusResponder(4012, 5012);
    const ssh = new FakeSSHClient((_t, _u, cmd) => {
      if (cmd.includes('BEGIN bellhop-managed') || cmd.includes('Caddyfile') || cmd.includes('caddy') || cmd.startsWith('cat ') || cmd.includes('STATUS_PAGE_EOF')) {
        throw new Error(`unexpected proxy-host command under proxyDriver 'none': ${cmd}`);
      }
      return respondStatus(_t, _u, cmd) as { stdout: string; stderr: string; code: number };
    });
    const inv: Inventory = { ...isolatedInventory(), proxyDriver: 'none' };
    const invPath = tempSavedInventoryPath(inv);
    const result = await runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    );
    assert.equal(result.applied, true);
    assert.equal(loadInventory(invPath).guests.find((g) => g.name === 'media')?.host, 'pve-secondary');
    assert.ok(
      infos.some((l) => l.includes("proxyDriver is 'none' -- skipping the status page render")),
      'the status-page skip line must be logged'
    );
    assert.ok(infos.some((l) => l.includes(NO_PROXY_SYNC_MESSAGE)), "sync-proxy's no-op message must be logged, not dropped");
    assert.ok(!infos.some((l) => l.includes('live via the proxy')), 'no "Pushing the new IP ... live via the proxy" line when there is no proxy');
    assert.ok(!warnings.some((w) => w.includes('proxy sync failed')), 'no proxy sync failed warning under a driver with nothing to sync');
  } finally {
    console.error = originalWarn;
    console.log = originalLog;
  }
});

test('runMigrateGuest apply warns but completes when the post-move proxy sync fails after the source is destroyed', async () => {
  const warnings: string[] = [];
  const originalWarn = console.error;
  console.error = (msg: string) => warnings.push(String(msg));
  try {
    const respondStatus = orderedStatusResponder(4012, 5012);
    const ssh = new FakeSSHClient((_t, _u, cmd) => {
      if (cmd.includes('BEGIN bellhop-managed')) return { stdout: '', stderr: 'caddy validate failed', code: 1 };
      return respondStatus(_t, _u, cmd) as { stdout: string; stderr: string; code: number };
    });
    const inv: Inventory = {
      ...isolatedInventory(),
      hosts: isolatedInventory().hosts.map((h) => (h.name === 'pve-main' ? { ...h, proxy: true } : h)),
    };
    const invPath = tempSavedInventoryPath(inv);
    const result = await runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    );
    assert.equal(result.applied, true, 'the migration itself must still count as successful');
    assert.ok(ssh.history.some((c) => c.command === 'pct destroy 4012'), 'the source was already destroyed');
    assert.equal(loadInventory(invPath).guests.find((g) => g.name === 'media')?.host, 'pve-secondary');
    const warning = warnings.find((w) => w.includes('proxy sync failed'));
    assert.ok(warning, 'a warning must name the failed proxy sync');
    assert.match(warning!, /migrated successfully/);
    assert.match(warning!, /caddy validate failed/);
    assert.match(warning!, /bellhop sync-proxy --apply/);
  } finally {
    console.error = originalWarn;
  }
});

// Issue #16: migrate-guest runs for minutes (vzdump, restore, verify) and in
// the MCP process nothing refreshes inventory mid-job. A setting written to
// disk by another process while that remote work runs must survive the
// command's final inventory save.
test('runMigrateGuest apply preserves a setting written to disk while the remote work was running', async () => {
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  const base = orderedStatusResponder(4012, 5012);
  let written = false;
  const ssh = new FakeSSHClient((target, user, cmd) => {
    if (!written && cmd.startsWith('vzdump')) {
      written = true;
      saveInventory(invPath, { ...loadInventory(invPath), dnsServer: '10.0.0.53' });
    }
    return base(target, user, cmd);
  });
  const result = await runMigrateGuest(
    { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
    { ssh, inventory: inv, inventoryPath: invPath }
  );
  assert.equal(result.applied, true);

  const reloaded = loadInventory(invPath);
  assert.equal(reloaded.dnsServer, '10.0.0.53', 'a concurrently-written setting must not be reverted');
  assert.equal(reloaded.guests.find((g) => g.name === 'media')?.vmid, 5012);
});

// --- Issue #53 US4: copy every Proxmox permission on the old VMID to the new
// one, after verification and before the original is destroyed. ---

const aclFixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'proxmox');
// Captured from a real host: one PVEVMAdmin user entry on /vms/4005.
const ACL_FILTERED_4005 = readFileSync(path.join(aclFixtureDir, 'acl-filtered.json'), 'utf8');

// The captured fixture's entry sits on /vms/4005, so these tests migrate a
// guest renumbered to vmid 4005 (default --mid 5 -> 5005 on pve-secondary).
function inventoryWithGuestAt4005(name: 'media' | 'winbox'): Inventory {
  const inv = isolatedInventory();
  inv.guests = inv.guests.map((g) => (g.name === name ? { ...g, vmid: 4005, ip: '192.168.1.5' } : g));
  return inv;
}

function aclResponder(base: ReturnType<typeof orderedStatusResponder>, acl: { stdout: string; stderr: string; code: number }, copy?: { stdout: string; stderr: string; code: number }) {
  return (t: string, u: string, cmd: string) => {
    if (cmd.includes('pvesh get /access/acl')) return acl;
    if (copy && cmd.startsWith('set -e\npveum acl modify')) return copy;
    return base(t, u, cmd) as { stdout: string; stderr: string; code: number };
  };
}

for (const [name, tool] of [
  ['media', 'pct'],
  ['winbox', 'qm'],
] as const) {
  test(`runMigrateGuest apply (${tool}) reads and copies the old VMID's permissions after verification and before destroying the original`, async () => {
    const inv = inventoryWithGuestAt4005(name);
    const invPath = tempSavedInventoryPath(inv);
    const ssh = new FakeSSHClient(aclResponder(orderedStatusResponder(4005, 5005), { stdout: ACL_FILTERED_4005, stderr: '', code: 0 }));
    const result = await runMigrateGuest(
      { guest: name, toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    );
    assert.equal(result.applied, true);

    const commands = ssh.history.map((c) => c.command);
    const targets = ssh.history.map((c) => c.sshTarget);
    const verifyIdx = commands.lastIndexOf(`${tool} status 5005`);
    const readIdx = commands.findIndex((c) => c.includes('pvesh get /access/acl'));
    const copyIdx = commands.findIndex((c) => c.startsWith('set -e\npveum acl modify'));
    const destroyIdx = commands.indexOf(`${tool} destroy 4005`);
    assert.ok(verifyIdx > -1 && readIdx > verifyIdx, 'the read must come after the running verification');
    assert.ok(copyIdx === readIdx + 1, 'the copy must follow the read directly');
    assert.ok(destroyIdx === copyIdx + 1, 'the destroy must come right after the copy');
    assert.match(commands[readIdx], /grep \{ \$_->\{path\} eq "\/vms\/4005" \}/);
    assert.equal(
      commands[copyIdx],
      "set -e\npveum acl modify '/vms/5005' --users 'alice@example.com@authentik' --roles 'PVEVMAdmin' --propagate 1"
    );
    assert.equal(targets[readIdx], 'pve-main.local');
    assert.equal(targets[copyIdx], 'pve-main.local');
  });
}

test('runMigrateGuest apply sends no copy script when the old VMID has no permissions', async () => {
  const inv = isolatedInventory();
  const invPath = tempSavedInventoryPath(inv);
  const ssh = new FakeSSHClient(orderedStatusResponder(4012, 5012));
  const { text } = await withCapturedConsole(() =>
    runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    )
  );
  const commands = ssh.history.map((c) => c.command);
  assert.ok(commands.some((c) => c.includes('pvesh get /access/acl')), 'the permissions must still be read');
  assert.ok(!commands.some((c) => c.includes('pveum acl modify')), 'nothing to copy, so no copy script');
  assert.match(text, /No permissions on \/vms\/4012 to copy/);
});

test('runMigrateGuest apply warns when the permission copy fails, and still destroys, cleans up and saves inventory', async () => {
  const inv = inventoryWithGuestAt4005('media');
  const invPath = tempSavedInventoryPath(inv);
  const ssh = new FakeSSHClient(
    aclResponder(orderedStatusResponder(4005, 5005), { stdout: ACL_FILTERED_4005, stderr: '', code: 0 }, { stdout: '', stderr: 'no such role', code: 2 })
  );
  const { text, result } = await withCapturedConsole(() =>
    runMigrateGuest(
      { guest: 'media', toHost: 'pve-secondary', apply: true, sleepFn: async () => {} },
      { ssh, inventory: inv, inventoryPath: invPath }
    )
  );
  assert.equal(result.applied, true, 'a failed copy must not fail the migration');
  assert.match(text, /Failed to copy permissions from \/vms\/4005 to \/vms\/5005 \(exit 2\): no such role -- run on pve-main by hand:/);
  const commands = ssh.history.map((c) => c.command);
  assert.ok(commands.includes('pct destroy 4005'), 'the original must still be destroyed');
  assert.ok(commands.some((c) => c.startsWith('rm -f')), 'the backup must still be cleaned up');
  assert.equal(loadInventory(invPath).guests.find((g) => g.name === 'media')?.vmid, 5005, 'inventory must still be saved');
});

// Issue #67: Bellhop's own guest is refused before any remote call, in a dry
// run too.
for (const apply of [false, true]) {
  test(`runMigrateGuest refuses the bellhopGuest before any remote call (apply: ${apply})`, async () => {
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    await assert.rejects(
      () =>
        runMigrateGuest(
          { guest: 'media', toHost: 'pve-secondary', apply },
          { ssh, inventory: { ...inventory, bellhopGuest: 'media' }, inventoryPath: tempInventoryPath() }
        ),
      /^Error: Refusing to migrate 'media': it is Bellhop's own guest \(the bellhopGuest setting\)/
    );
    assert.equal(ssh.history.length, 0);
  });
}
