import type { SSHClient } from './ssh-client.ts';
import type { Inventory, HostEntry } from './inventory.ts';
import { runRemote } from './targets.ts';
import { logInfo } from './log.ts';

export interface NfsMountLine {
  exportPath: string;
  mountPoint: string;
}

export function parseNfsLines(fstabContent: string, nfsServer: string): NfsMountLine[] {
  const prefix = `${nfsServer}:`;
  const lines: NfsMountLine[] = [];
  for (const rawLine of fstabContent.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    const [device, mountPoint, fstype] = fields;
    if (fstype === 'nfs' && device.startsWith(prefix)) {
      lines.push({ exportPath: device.slice(prefix.length), mountPoint });
    }
  }
  return lines;
}

export interface MpEntry {
  index: number;
  hostPath: string;
  mountPoint: string; // the guest-side path (the mp=<path> value)
}

// Shared by attach-nfs-mount/migrate-nfs-mount (picking the next free mpN
// slot, detecting an existing bind-mount at a given guest path) and
// audit-nfs-mounts (matching each bind-mount's host-side path against known
// NFS locations) -- previously each command had its own near-identical
// private regex for this.
export function parseMpEntries(pctConfig: string): MpEntry[] {
  const entries: MpEntry[] = [];
  for (const line of pctConfig.split('\n')) {
    const match = line.match(/^mp(\d+):\s*([^,]+),mp=([^,]+)/);
    if (match) {
      entries.push({ index: Number(match[1]), hostPath: match[2], mountPoint: match[3] });
    }
  }
  return entries;
}

export function nextFreeMpIndex(entries: MpEntry[]): number {
  const used = new Set(entries.map((e) => e.index));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

export async function resolveNfsMountPath(
  ssh: SSHClient,
  inventory: Inventory,
  host: HostEntry,
  storageName: string
): Promise<string> {
  const fstabMount = host.nfsMounts?.find((m) => m.name === storageName);
  if (fstabMount) {
    logInfo(`Using fstab-based NFS mount '${storageName}' on ${host.name} (${fstabMount.mountPoint})`);
    return fstabMount.mountPoint;
  }

  logInfo(`Looking up storage '${storageName}' on ${host.name}...`);
  const storageResult = await runRemote(ssh, inventory, host.name, `pvesh get /storage/${storageName} --output-format json`);
  if (storageResult.code !== 0) {
    throw new Error(`Failed to look up storage '${storageName}' on ${host.name} -- does it exist?`);
  }
  const storagePath = JSON.parse(storageResult.stdout).path ?? '';
  if (!storagePath) {
    throw new Error(`Storage '${storageName}' has no 'path' -- is it type 'nfs'?`);
  }
  return storagePath;
}

export function buildNfsAttachScript(vmid: number, mpIndex: number, storagePath: string, mountPoint: string): string {
  return [`pct set ${vmid} -mp${mpIndex} ${storagePath},mp=${mountPoint}`, `pct reboot ${vmid}`].join('\n');
}
