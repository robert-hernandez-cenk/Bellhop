import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { runDeleteGuest } from '../../src/commands/provisioning/delete-guest.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'winbox', type: 'vm', vmid: 106, host: 'pve1' },
  ],
};

// A placeholder for tests that throw or dry-run before runDeleteGuest ever
// reaches its inventory-write step -- inventoryPath is a required dep, but
// these tests never touch disk with it.
const UNUSED_INVENTORY_PATH = 'unused';

function tempInventoryPath(inv: Inventory): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

// A fresh guests-array clone of the module inventory, for any test whose
// apply succeeds -- runDeleteGuest mutates deps.inventory.guests in place,
// and these tests must not step on each other via the shared module const.
function freshInventory(): Inventory {
  return { ...inventory, guests: [...inventory.guests] };
}

function responder(opts: { status: string; vzdumpCode?: number }) {
  return (_target: string, _user: string, cmd: string) => {
    if (cmd.includes('status')) return { stdout: opts.status, stderr: '', code: 0 };
    if (cmd.startsWith('vzdump')) {
      return { stdout: '', stderr: opts.vzdumpCode ? 'vzdump failed' : '', code: opts.vzdumpCode ?? 0 };
    }
    if (cmd.includes('stop') || cmd.includes('destroy')) return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected command: ${cmd}`);
  };
}

test('runDeleteGuest rejects an unknown/non-lxc/vm target name', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runDeleteGuest({ guest: 'pve1' }, { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH }),
    /is not an lxc\/vm guest in inventory/
  );
  assert.equal(ssh.history.length, 0);
});

test('runDeleteGuest throws immediately when --backup is set without --backup-storage', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runDeleteGuest({ guest: 'media', backup: true }, { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH }),
    /--backup-storage is required/
  );
  assert.equal(ssh.history.length, 0);
});

test('runDeleteGuest rejects a backupStorage containing shell metacharacters', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runDeleteGuest(
        { guest: 'media', backup: true, backupStorage: 'nas; rm -rf /' },
        { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH }
      ),
    /--backup-storage must contain only letters, digits, dots, hyphens, and underscores/
  );
  assert.equal(ssh.history.length, 0);
});

test('runDeleteGuest does not mutate anything in dry run, and the script includes the stop step when running', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: running' }));
  const result = await runDeleteGuest({ guest: 'media' }, { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH });
  assert.equal(result.applied, false);
  assert.match(result.script, /pct stop 105/);
  assert.match(result.script, /pct destroy 105/);
  assert.equal(ssh.history.length, 1); // status check only, no mutation
});

test('runDeleteGuest omits the stop step when the guest is already stopped', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const result = await runDeleteGuest({ guest: 'media' }, { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH });
  assert.doesNotMatch(result.script, /pct stop/);
  assert.match(result.script, /pct destroy 105/);
});

test('runDeleteGuest stops then destroys a running lxc guest on apply', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: running' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest({ guest: 'media', apply: true }, { ssh, inventory: inv, inventoryPath });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 3); // status, stop, destroy
  assert.match(ssh.history[1].command, /pct stop 105/);
  assert.match(ssh.history[2].command, /pct destroy 105/);
});

test('runDeleteGuest destroys directly, no stop command, when already stopped', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest({ guest: 'media', apply: true }, { ssh, inventory: inv, inventoryPath });
  assert.equal(ssh.history.length, 2); // status, destroy
  assert.match(ssh.history[1].command, /pct destroy 105/);
});

test('runDeleteGuest backs up before destroying when --backup is set', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest(
    { guest: 'media', apply: true, backup: true, backupStorage: 'nas-proxmox' },
    { ssh, inventory: inv, inventoryPath }
  );
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 3); // status, vzdump, destroy
  assert.match(ssh.history[1].command, /vzdump 105 --storage nas-proxmox --mode snapshot/);
  assert.match(ssh.history[2].command, /pct destroy 105/);
});

test('runDeleteGuest aborts before destroy when the backup fails', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped', vzdumpCode: 1 }));
  await assert.rejects(
    () =>
      runDeleteGuest(
        { guest: 'media', apply: true, backup: true, backupStorage: 'nas-proxmox' },
        { ssh, inventory, inventoryPath: UNUSED_INVENTORY_PATH }
      ),
    /Backup of media failed/
  );
  assert.equal(ssh.history.length, 2); // status, failed vzdump -- destroy never runs
});

test('runDeleteGuest uses qm for a vm guest', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest({ guest: 'winbox', apply: true }, { ssh, inventory: inv, inventoryPath });
  assert.match(ssh.history[0].command, /qm status 106/);
  assert.match(ssh.history[1].command, /qm destroy 106/);
});

test('runDeleteGuest removes the destroyed guest from inventory on apply, leaving other guests untouched', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest({ guest: 'media', apply: true }, { ssh, inventory: inv, inventoryPath });
  assert.equal(result.applied, true);

  const reloaded = loadInventory(inventoryPath);
  assert.ok(!reloaded.guests.some((g) => g.name === 'media'), 'destroyed guest must be gone from a fresh load');
  assert.ok(reloaded.guests.some((g) => g.name === 'winbox'), 'other guests must be untouched');
});

test('runDeleteGuest leaves inventory untouched on a dry run', async () => {
  const ssh = new FakeSSHClient(responder({ status: 'status: stopped' }));
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const result = await runDeleteGuest({ guest: 'media' }, { ssh, inventory: inv, inventoryPath });
  assert.equal(result.applied, false);

  const reloaded = loadInventory(inventoryPath);
  assert.ok(reloaded.guests.some((g) => g.name === 'media'), 'guest must remain in inventory after a dry run');
});

// Issue #16: a delete-guest job can run for minutes (stop, vzdump, destroy)
// and in the MCP process nothing refreshes inventory mid-job. A setting
// written to disk by another process (Dashboard/Settings/CLI) while the
// remote work is in flight must survive the command's final inventory save.
test('runDeleteGuest apply preserves a setting written to disk while the remote work was running', async () => {
  const inv = freshInventory();
  const inventoryPath = tempInventoryPath(inv);
  const base = responder({ status: 'status: running' });
  const ssh = new FakeSSHClient((target, user, cmd) => {
    if (cmd.includes('destroy')) {
      saveInventory(inventoryPath, { ...loadInventory(inventoryPath), dnsServer: '10.0.0.53' });
    }
    return base(target, user, cmd);
  });
  const result = await runDeleteGuest({ guest: 'media', apply: true }, { ssh, inventory: inv, inventoryPath });
  assert.equal(result.applied, true);

  const reloaded = loadInventory(inventoryPath);
  assert.equal(reloaded.dnsServer, '10.0.0.53', 'a concurrently-written setting must not be reverted');
  assert.ok(!reloaded.guests.some((g) => g.name === 'media'));
});
