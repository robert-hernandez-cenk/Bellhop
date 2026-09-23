import type { SSHClient } from './ssh-client.ts';
import type { Inventory } from './inventory.ts';
import { runRemote } from './targets.ts';

export interface GuestStatusResult {
  statuses: Record<string, 'running' | 'stopped'>;
  failures: string[];
}

interface PveStatusEntry {
  vmid: number;
  status: string;
}

const PVE_TYPES: Array<'lxc' | 'qemu'> = ['lxc', 'qemu'];

export async function getGuestStatuses(ssh: SSHClient, inventory: Inventory): Promise<GuestStatusResult> {
  const statuses: Record<string, 'running' | 'stopped'> = {};
  const failures: string[] = [];

  for (const host of inventory.hosts) {
    let hostFailed = false;
    const hostStatuses: Record<string, 'running' | 'stopped'> = {};
    for (const pveType of PVE_TYPES) {
      try {
        const result = await runRemote(
          ssh,
          inventory,
          host.name,
          `pvesh get /nodes/\$(hostname)/${pveType} --output-format json`
        );
        if (result.code !== 0) throw new Error(`exit code ${result.code}`);
        const entries: PveStatusEntry[] = JSON.parse(result.stdout || '[]');
        for (const entry of entries) {
          const guest = inventory.guests.find((g) => g.host === host.name && g.vmid === entry.vmid);
          if (!guest) continue;
          hostStatuses[guest.name] = entry.status === 'running' ? 'running' : 'stopped';
        }
      } catch {
        hostFailed = true;
      }
    }
    if (hostFailed) {
      failures.push(host.name);
    } else {
      Object.assign(statuses, hostStatuses);
    }
  }

  return { statuses, failures };
}
