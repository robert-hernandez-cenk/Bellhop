import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, resolveMid, type ResolvedMid } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { pickStorage } from '../../lib/storage.ts';

export interface CreateVmOptions {
  host: string;
  mid: number;
  name: string;
  cores?: number;
  memory?: number;
  diskStorage?: string;
  disk?: number;
  bridge?: string;
  cloudInit?: boolean;
  apply?: boolean;
}

export function buildCreateVmCommand(opts: CreateVmOptions, mid: ResolvedMid): string {
  const cores = opts.cores ?? 2;
  const memory = opts.memory ?? 2048;
  const diskStorage = opts.diskStorage ?? 'local-lvm';
  const disk = opts.disk ?? 20;
  const bridge = opts.bridge ?? 'vmbr0';
  let cmd =
    `qm create ${mid.vmid} --name ${shellQuote(opts.name)} --cores ${cores} --memory ${memory} ` +
    `--net0 virtio,bridge=${shellQuote(bridge)} --scsi0 ${shellQuote(diskStorage)}:${disk} ` +
    `--ipconfig0 ip=${shellQuote(mid.ip)},gw=${shellQuote(mid.gateway)}`;
  if (opts.cloudInit) {
    cmd += ` --ide2 ${shellQuote(diskStorage)}:cloudinit --boot order=scsi0`;
  }
  return cmd;
}

export async function runCreateVm(
  opts: CreateVmOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ command: string; mid: ResolvedMid; applied: boolean }> {
  if (opts.diskStorage && !/^[a-zA-Z0-9_-]+$/.test(opts.diskStorage)) {
    throw new Error(`--disk-storage must contain only letters, digits, hyphens, and underscores, got: ${opts.diskStorage}`);
  }
  const host = deps.inventory.hosts.find((h) => h.name === opts.host);
  if (!host) {
    throw new Error(`Not a Proxmox host in inventory: ${opts.host}`);
  }
  const mid = resolveMid(deps.inventory, opts.host, opts.mid);
  // buildCreateVmCommand's own `?? 'local-lvm'` fallback stays for direct
  // callers/tests; runCreateVm resolves a host-aware default here instead,
  // since different hosts can have different pools available (same
  // reasoning as create-lxc's --storage / install-app's pickStorage).
  const diskStorage = opts.diskStorage || pickStorage(host, ['images']);
  const command = buildCreateVmCommand({ ...opts, diskStorage }, mid);

  const applied = confirmOrDryRun(`Would run on ${opts.host}: ${command}`, opts.apply ?? false);
  if (applied) {
    const result = await runRemote(deps.ssh, deps.inventory, opts.host, command);
    if (result.code !== 0) {
      throw new Error(`qm create failed on ${opts.host} (exit ${result.code}): ${result.stderr || result.stdout}`);
    }
  }
  return { command, mid, applied };
}
