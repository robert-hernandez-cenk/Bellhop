import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { saveInventory, refreshInventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';

export interface DeleteGuestOptions {
  guest: string;
  apply?: boolean;
  backup?: boolean;
  backupStorage?: string;
}

export interface DeleteGuestResult {
  script: string;
  applied: boolean;
}

function pctOrQm(type: 'lxc' | 'vm'): string {
  return type === 'lxc' ? 'pct' : 'qm';
}

export async function runDeleteGuest(
  opts: DeleteGuestOptions,
  deps: { ssh: SSHClient; inventory: Inventory; inventoryPath: string }
): Promise<DeleteGuestResult> {
  if (opts.backup && !opts.backupStorage) {
    throw new Error('--backup-storage is required when --backup is set');
  }
  if (opts.backupStorage && !/^[A-Za-z0-9._-]+$/.test(opts.backupStorage)) {
    throw new Error(
      `--backup-storage must contain only letters, digits, dots, hyphens, and underscores, got: ${opts.backupStorage}`
    );
  }

  const guest = deps.inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || (guest.type !== 'lxc' && guest.type !== 'vm')) {
    throw new Error(`'${opts.guest}' is not an lxc/vm guest in inventory`);
  }
  const parentHost = guest.host;
  const tool = pctOrQm(guest.type);

  const statusResult = await runRemote(deps.ssh, deps.inventory, parentHost, `${tool} status ${guest.vmid}`);
  const isRunning = /status:\s*running/.test(statusResult.stdout);

  const lines: string[] = [];
  if (isRunning) {
    lines.push(`# ${opts.guest} is running -- stop it first`, `${tool} stop ${guest.vmid}`);
  }
  if (opts.backup) {
    lines.push(
      `# Back up ${opts.guest} before destroying it -- abort before destroy if this fails`,
      `vzdump ${guest.vmid} --storage ${opts.backupStorage} --mode snapshot`
    );
  }
  lines.push(`# Destroy ${opts.guest}`, `${tool} destroy ${guest.vmid}`);
  const script = lines.join('\n');

  const applied = confirmOrDryRun(
    `Would run on ${parentHost} to destroy ${opts.guest} (vmid ${guest.vmid}):\n${script}`,
    opts.apply ?? false
  );
  if (!applied) {
    return { script, applied: false };
  }

  if (isRunning) {
    const stop = await runRemote(deps.ssh, deps.inventory, parentHost, `${tool} stop ${guest.vmid}`);
    if (stop.code !== 0) {
      throw new Error(`Failed to stop ${opts.guest} on ${parentHost} (exit ${stop.code}): ${stop.stderr || stop.stdout}`);
    }
  }

  if (opts.backup) {
    const backup = await runRemote(
      deps.ssh,
      deps.inventory,
      parentHost,
      `vzdump ${guest.vmid} --storage ${opts.backupStorage} --mode snapshot`
    );
    if (backup.code !== 0) {
      throw new Error(
        `Backup of ${opts.guest} failed on ${parentHost} (exit ${backup.code}): ${backup.stderr || backup.stdout} -- aborting before destroy`
      );
    }
  }

  const destroy = await runRemote(deps.ssh, deps.inventory, parentHost, `${tool} destroy ${guest.vmid}`);
  if (destroy.code !== 0) {
    throw new Error(`Failed to destroy ${opts.guest} on ${parentHost} (exit ${destroy.code}): ${destroy.stderr || destroy.stdout}`);
  }

  // Issue #16: this save lands at the end of a multi-minute remote pipeline,
  // and nothing refreshes inventory mid-job (the MCP process has no
  // per-request reload the way the web service does). Reload from disk first
  // and derive the new guests array from that fresh copy, so an edit another
  // process made meanwhile (a Dashboard/Settings change, a CLI run) isn't
  // silently reverted by a wholesale save from the job-start snapshot.
  refreshInventory(deps.inventory, deps.inventoryPath);
  const guests = deps.inventory.guests.filter((g) => g.name !== opts.guest);
  saveInventory(deps.inventoryPath, { ...deps.inventory, guests });
  deps.inventory.guests = guests;

  return { script, applied: true };
}
