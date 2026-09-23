import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, selectTargets } from '../../lib/targets.ts';
import { parseMpEntries } from '../../lib/nfs.ts';
import { logWarn } from '../../lib/log.ts';
import { errorMessage, exitCodeError, formatFailureList, type TargetFailure } from '../../lib/target-failure.ts';

export interface AuditNfsMountsOptions {
  host?: string;
}

export interface NfsMountUsage {
  name: string;
  export?: string;
  hostPath: string;
  users: string[];
}

export interface AuditNfsMountsResult {
  usages: NfsMountUsage[];
  matchedCount: number;
  cleanCount: number;
  unreachable: TargetFailure[];
}

// Maps every host-side path this toolkit knows is NFS-backed to a friendly
// name: a host's own discovered fstab mounts (sync-inventory's nfsMounts[])
// plus any Proxmox-managed `nfs:` storage, whose host path Proxmox always
// mounts at the deterministic `/mnt/pve/<storage-name>` (confirmed live),
// so no extra pvesh call is needed to resolve it here.
function knownNfsPaths(host: Inventory['hosts'][number]): Map<string, { name: string; export?: string }> {
  const map = new Map<string, { name: string; export?: string }>();
  for (const mount of host.nfsMounts ?? []) {
    map.set(mount.mountPoint, { name: mount.name, export: mount.export });
  }
  for (const storage of host.storages ?? []) {
    if (storage.type === 'nfs') {
      map.set(`/mnt/pve/${storage.name}`, { name: storage.name });
    }
  }
  return map;
}

export async function runAuditNfsMounts(
  opts: AuditNfsMountsOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<AuditNfsMountsResult> {
  let targets: string[];
  if (opts.host) {
    const guest = deps.inventory.guests.find((g) => g.name === opts.host);
    if (!guest || guest.type !== 'lxc') {
      throw new Error(`'${opts.host}' is not an lxc guest in inventory`);
    }
    targets = [opts.host];
  } else {
    targets = selectTargets(deps.inventory, { group: 'lxc' });
  }

  if (targets.length === 0) {
    throw new Error('No lxc guests found in inventory');
  }

  const usageByName = new Map<string, NfsMountUsage>();
  const unreachable: TargetFailure[] = [];
  let matchedCount = 0;
  let cleanCount = 0;

  for (const targetName of targets) {
    const guest = deps.inventory.guests.find((g) => g.name === targetName)!;
    const host = deps.inventory.hosts.find((h) => h.name === guest.host)!;
    const known = knownNfsPaths(host);

    let pctConfig: string;
    try {
      const result = await runRemote(deps.ssh, deps.inventory, guest.host, `pct config ${guest.vmid}`);
      if (result.code !== 0) throw exitCodeError(result);
      pctConfig = result.stdout;
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to read pct config for ${targetName} on ${guest.host}, skipping: ${error}`);
      unreachable.push({ target: targetName, error });
      continue;
    }

    let matchedAny = false;
    for (const entry of parseMpEntries(pctConfig)) {
      const match = known.get(entry.hostPath);
      if (!match) continue;
      matchedAny = true;
      const usage = usageByName.get(match.name) ?? {
        name: match.name,
        export: match.export,
        hostPath: entry.hostPath,
        users: [],
      };
      usage.users.push(`${targetName} (${entry.mountPoint})`);
      usageByName.set(match.name, usage);
    }
    if (matchedAny) matchedCount += 1;
    else cleanCount += 1;
  }

  return {
    usages: [...usageByName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    matchedCount,
    cleanCount,
    unreachable,
  };
}

export function formatAuditNfsMounts(result: AuditNfsMountsResult): string {
  const lines: string[] = [];
  if (result.usages.length > 0) {
    lines.push('NFS shares in use, by mount:');
    for (const usage of result.usages) {
      lines.push(`  ${usage.name}${usage.export ? ` (${usage.export})` : ''} -- ${usage.hostPath}`);
      lines.push(`    mounted by: ${usage.users.join(', ')}`);
    }
  } else {
    lines.push('No NFS shares found on any audited container.');
  }
  const total = result.matchedCount + result.cleanCount;
  let summary = `${result.usages.length} NFS mount(s) in use across ${result.matchedCount} container(s) of ${total} audited; ${result.cleanCount} container(s) have no NFS-backed bind-mount`;
  summary +=
    result.unreachable.length > 0
      ? `; ${result.unreachable.length} unreachable (${formatFailureList(result.unreachable)})`
      : '; 0 unreachable';
  lines.push(summary);
  return lines.join('\n');
}
