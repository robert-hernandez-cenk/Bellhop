import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory, GuestEntry, HostEntry, BridgeEntry, StorageEntry, NfsMountEntry } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { parseNfsLines } from '../../lib/nfs.ts';
import { logWarn } from '../../lib/log.ts';
import { errorMessage, exitCodeError, type TargetFailure } from '../../lib/target-failure.ts';

export interface SyncInventoryOptions {
  apply?: boolean;
  fstabPath?: string;
  nfsServer?: string;
}

export interface SyncInventoryResult {
  guests: GuestEntry[];
  hosts: HostEntry[];
  newEntries: string[];
  updatedEntries: string[];
  removedEntries: string[];
  bridgeFailures: TargetFailure[];
  storageFailures: TargetFailure[];
  nfsMountFailures: TargetFailure[];
  nfsMountsSkipped: boolean;
}

interface PveListEntry {
  vmid: number;
  name: string;
  template?: number;
}

interface PveNetworkInterface {
  iface: string;
  type: string;
  active?: number;
  comments?: string;
}

interface PveStorage {
  storage: string;
  type: string;
  content: string;
  active?: number;
  enabled?: number;
  total?: number;
}

// Proxmox lets you set a free-text "Comment" on a network interface (Datacenter
// -> node -> System -> Network); we surface that as the bridge's alias rather
// than asking the operator to hand-maintain a second copy of it in hosts.yaml.
// Falls back to this when a bridge has no comment set yet.
const DEFAULT_BRIDGE_ALIAS = 'LAN';

function extractIp(netStr: string): string {
  for (const part of netStr.split(',')) {
    if (part.startsWith('ip=')) {
      return part.slice('ip='.length).split('/')[0];
    }
  }
  return '';
}

const PVE_TYPES: Array<['lxc' | 'qemu', 'lxc' | 'vm']> = [
  ['lxc', 'lxc'],
  ['qemu', 'vm'],
];

// Only content types install-app's pickStorage ever selects on
// (var_template_storage needs 'vztmpl'; var_container_storage needs
// 'rootdir'/'images') -- a storage that supports none of these (backup-only,
// iso-only, snippets-only, ...) is never a candidate for anything this
// toolkit does with a storage pool, so it's dropped instead of cluttering
// hosts.yaml with pools that will never actually be picked.
const RELEVANT_STORAGE_CONTENT_TYPES = ['vztmpl', 'rootdir', 'images'];

export async function runSyncInventory(
  opts: SyncInventoryOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<SyncInventoryResult> {
  const { inventory } = deps;
  const fstabPath = opts.fstabPath ?? '/etc/fstab';
  // The option (which src/cli.ts fills from the NFS_SERVER env var) wins
  // over the inventory value; unset in both means we can't tell which
  // fstab lines belong to the NAS, so the scan is skipped rather than
  // failing the whole reconcile.
  const nfsServer = opts.nfsServer ?? inventory.nfsServer;
  const nfsMountsSkipped = nfsServer === undefined;
  // The CLI always prints formatSyncInventory's own summary line, so this
  // duplicates that same fact as a log line too -- the one caller that
  // doesn't print the summary is the web apply path (src/web/routes/
  // maintenance.ts), which would otherwise give no indication at all that
  // the scan was skipped.
  if (nfsMountsSkipped) {
    logWarn('nfsServer is not set -- skipping NFS mount discovery -- run: bellhop set-config nfsServer <ip> --apply');
  }
  const finalGuests: GuestEntry[] = [];
  const newEntries: string[] = [];
  const updatedEntries: string[] = [];
  const removedEntries: string[] = [];
  const matchedKeys = new Set<string>();
  const failedHostTypes = new Set<string>();

  const finalHosts: HostEntry[] = [];
  const bridgeFailures: TargetFailure[] = [];
  const storageFailures: TargetFailure[] = [];
  const nfsMountFailures: TargetFailure[] = [];
  for (const host of inventory.hosts) {
    let updatedHost = host;
    try {
      const result = await runRemote(
        deps.ssh,
        inventory,
        host.name,
        `pvesh get /nodes/\$(hostname)/network --output-format json`
      );
      if (result.code !== 0) throw exitCodeError(result);
      const interfaces: PveNetworkInterface[] = JSON.parse(result.stdout);
      const bridges: BridgeEntry[] = interfaces
        .filter((iface) => iface.type === 'bridge')
        .map((iface) => ({
          name: iface.iface,
          alias: iface.comments?.trim() || DEFAULT_BRIDGE_ALIAS,
          active: !!iface.active,
        }));
      updatedHost = { ...updatedHost, bridges };
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to query network interfaces on ${host.name}, keeping existing bridges unchanged: ${error}`);
      bridgeFailures.push({ target: host.name, error });
    }

    try {
      const result = await runRemote(
        deps.ssh,
        inventory,
        host.name,
        `pvesh get /nodes/\$(hostname)/storage --output-format json`
      );
      if (result.code !== 0) throw exitCodeError(result);
      const pveStorages: PveStorage[] = JSON.parse(result.stdout);
      const storages: StorageEntry[] = pveStorages
        .map((s) => ({
          name: s.storage,
          type: s.type,
          content: s.content
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean),
          active: !!s.active && !!s.enabled,
          totalBytes: typeof s.total === 'number' ? s.total : undefined,
        }))
        .filter((s) => s.content.some((c) => RELEVANT_STORAGE_CONTENT_TYPES.includes(c)));
      updatedHost = { ...updatedHost, storages };
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to query storage pools on ${host.name}, keeping existing storages unchanged: ${error}`);
      storageFailures.push({ target: host.name, error });
    }

    if (nfsServer !== undefined) {
      try {
        const result = await runRemote(deps.ssh, inventory, host.name, `cat '${fstabPath}' 2>/dev/null`);
        if (result.code !== 0) throw exitCodeError(result);
        const parsed = parseNfsLines(result.stdout, nfsServer);
        const nfsMounts: NfsMountEntry[] = [];
        for (const { exportPath, mountPoint } of parsed) {
          const name = mountPoint.split('/').filter(Boolean).pop() ?? mountPoint;
          const activeResult = await runRemote(deps.ssh, inventory, host.name, `mountpoint -q '${mountPoint}'`);
          nfsMounts.push({ name, export: exportPath, mountPoint, active: activeResult.code === 0 });
        }
        updatedHost = { ...updatedHost, nfsMounts };
      } catch (err) {
        const error = errorMessage(err);
        logWarn(`Failed to query fstab NFS mounts on ${host.name}, keeping existing nfsMounts unchanged: ${error}`);
        nfsMountFailures.push({ target: host.name, error });
      }
    }

    finalHosts.push(updatedHost);
  }

  for (const host of inventory.hosts) {
    for (const [pveType, invType] of PVE_TYPES) {
      let listJson: string;
      try {
        const result = await runRemote(
          deps.ssh,
          inventory,
          host.name,
          `pvesh get /nodes/\$(hostname)/${pveType} --output-format json`
        );
        if (result.code !== 0) throw exitCodeError(result);
        listJson = result.stdout;
      } catch (err) {
        logWarn(`Failed to query ${pveType} list on ${host.name}, skipping: ${errorMessage(err)}`);
        failedHostTypes.add(`${host.name}|${invType}`);
        continue;
      }
      if (!listJson.trim()) continue;

      const list: PveListEntry[] = JSON.parse(listJson);
      for (const entry of list) {
        if (entry.template === 1) continue;
        const vmid = entry.vmid;
        const existing = inventory.guests.find((g) => g.host === host.name && g.vmid === vmid);

        let ip = '';
        try {
          const configResult = await runRemote(
            deps.ssh,
            inventory,
            host.name,
            `pvesh get /nodes/\$(hostname)/${pveType}/${vmid}/config --output-format json`
          );
          const config = JSON.parse(configResult.stdout);
          const netField = pveType === 'qemu' ? 'ipconfig0' : 'net0';
          if (config[netField]) {
            ip = extractIp(config[netField]);
          }
        } catch (err) {
          const error = errorMessage(err);
          matchedKeys.add(`${host.name}|${vmid}`);
          if (existing) {
            logWarn(
              `Failed to fetch config for ${existing.name} (host=${host.name} vmid=${vmid}), keeping existing type/ip unchanged: ${error}`
            );
            finalGuests.push(existing);
          } else {
            logWarn(
              `Failed to fetch config for ${entry.name} (host=${host.name} vmid=${vmid}), adding with empty ip: ${error}`
            );
            finalGuests.push({ name: entry.name, type: invType, vmid, host: host.name });
            newEntries.push(`${entry.name} (type=${invType} vmid=${vmid} host=${host.name} ip='')`);
          }
          continue;
        }

        matchedKeys.add(`${host.name}|${vmid}`);
        if (existing) {
          const finalEntry: GuestEntry = { ...existing, type: invType, ip: ip || undefined };
          finalGuests.push(finalEntry);
          if (existing.type !== invType || (existing.ip ?? '') !== ip) {
            updatedEntries.push(
              `${existing.name} (host=${host.name} vmid=${vmid}): type '${existing.type}' -> '${invType}', ip '${existing.ip ?? ''}' -> '${ip}'`
            );
          }
        } else {
          const finalEntry: GuestEntry = { name: entry.name, type: invType, vmid, host: host.name, ip: ip || undefined };
          finalGuests.push(finalEntry);
          newEntries.push(`${entry.name} (type=${invType} vmid=${vmid} host=${host.name} ip='${ip}')`);
        }
      }
    }
  }

  for (const guest of inventory.guests) {
    const key = `${guest.host}|${guest.vmid}`;
    if (failedHostTypes.has(`${guest.host}|${guest.type}`)) {
      logWarn(
        `Skipping removal-check for ${guest.name} (host=${guest.host} vmid=${guest.vmid}): host query failed, keeping existing entry unchanged`
      );
      finalGuests.push(guest);
      continue;
    }
    if (!matchedKeys.has(key)) {
      removedEntries.push(`${guest.name} (host=${guest.host} vmid=${guest.vmid})`);
    }
  }

  return {
    guests: finalGuests,
    hosts: finalHosts,
    newEntries,
    updatedEntries,
    removedEntries,
    bridgeFailures,
    storageFailures,
    nfsMountFailures,
    nfsMountsSkipped,
  };
}

export function formatSyncInventory(result: SyncInventoryResult): string {
  const lines: string[] = [];
  lines.push(`New guests: ${result.newEntries.length}`);
  for (const e of result.newEntries) lines.push(`  + ${e}`);
  lines.push(`Updated guests: ${result.updatedEntries.length}`);
  for (const e of result.updatedEntries) lines.push(`  ~ ${e}`);
  lines.push(`Removed guests: ${result.removedEntries.length}`);
  for (const e of result.removedEntries) lines.push(`  - ${e}`);
  const okBridgeHosts = result.hosts.length - result.bridgeFailures.length;
  lines.push(`Bridges refreshed for ${okBridgeHosts}/${result.hosts.length} host(s)`);
  for (const host of result.hosts) {
    const bridgeFailure = result.bridgeFailures.find((f) => f.target === host.name);
    if (bridgeFailure) {
      lines.push(`  ${host.name}: unreachable, bridges unchanged -- ${bridgeFailure.error}`);
      continue;
    }
    for (const bridge of host.bridges ?? []) {
      lines.push(`  ${host.name}/${bridge.name}: alias='${bridge.alias}' active=${bridge.active}`);
    }
  }
  const okStorageHosts = result.hosts.length - result.storageFailures.length;
  lines.push(`Storages refreshed for ${okStorageHosts}/${result.hosts.length} host(s)`);
  for (const host of result.hosts) {
    const storageFailure = result.storageFailures.find((f) => f.target === host.name);
    if (storageFailure) {
      lines.push(`  ${host.name}: unreachable, storages unchanged -- ${storageFailure.error}`);
      continue;
    }
    for (const storage of host.storages ?? []) {
      lines.push(`  ${host.name}/${storage.name}: type=${storage.type} content=[${storage.content.join(',')}] active=${storage.active}`);
    }
  }
  if (result.nfsMountsSkipped) {
    lines.push('NFS mounts: skipped -- nfsServer is not set -- run: bellhop set-config nfsServer <ip> --apply');
  } else {
    const okNfsMountHosts = result.hosts.length - result.nfsMountFailures.length;
    lines.push(`NFS fstab mounts refreshed for ${okNfsMountHosts}/${result.hosts.length} host(s)`);
    for (const host of result.hosts) {
      const nfsMountFailure = result.nfsMountFailures.find((f) => f.target === host.name);
      if (nfsMountFailure) {
        lines.push(`  ${host.name}: unreachable, nfsMounts unchanged -- ${nfsMountFailure.error}`);
        continue;
      }
      for (const mount of host.nfsMounts ?? []) {
        lines.push(`  ${host.name}/${mount.name}: export='${mount.export}' mountPoint='${mount.mountPoint}' active=${mount.active}`);
      }
    }
  }
  return lines.join('\n');
}
