import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { logInfo } from '../../lib/log.ts';
import { parseMpEntries, nextFreeMpIndex, resolveNfsMountPath, buildNfsAttachScript } from '../../lib/nfs.ts';

export interface AttachNfsMountOptions {
  guest: string;
  storage: string;
  mountPoint: string;
  apply?: boolean;
}

export async function runAttachNfsMount(
  opts: AttachNfsMountOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ hostScript: string; applied: boolean }> {
  if (!/^[A-Za-z0-9._-]+$/.test(opts.storage)) {
    throw new Error(`--storage must contain only letters, digits, dots, hyphens, and underscores, got: ${opts.storage}`);
  }
  if (!opts.mountPoint.startsWith('/')) {
    throw new Error(`--mount-point must be an absolute path, got: ${opts.mountPoint}`);
  }

  const guest = deps.inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || guest.type !== 'lxc') {
    throw new Error(`'${opts.guest}' is not an lxc guest in inventory`);
  }
  const parentHost = guest.host;
  const parentHostEntry = deps.inventory.hosts.find((h) => h.name === parentHost);
  if (!parentHostEntry) {
    throw new Error(`Inventory entry '${opts.guest}' has host '${parentHost}' which does not match any entry in hosts[]`);
  }

  const storagePath = await resolveNfsMountPath(deps.ssh, deps.inventory, parentHostEntry, opts.storage);

  logInfo(`Checking ${opts.guest}'s existing bind-mounts for a conflict at ${opts.mountPoint}...`);
  const configResult = await runRemote(deps.ssh, deps.inventory, parentHost, `pct config ${guest.vmid}`);
  if (configResult.code !== 0) {
    throw new Error(`Failed to read pct config for vmid ${guest.vmid} on ${parentHost}`);
  }
  const mpEntries = parseMpEntries(configResult.stdout);
  if (mpEntries.some((e) => e.mountPoint === opts.mountPoint)) {
    throw new Error(`${opts.guest} already has a bind-mount configured at ${opts.mountPoint} -- refusing to add a duplicate`);
  }

  const mpIndex = nextFreeMpIndex(mpEntries);
  logInfo(`Using mp${mpIndex}`);
  const hostScript = buildNfsAttachScript(guest.vmid, mpIndex, storagePath, opts.mountPoint);

  if (!opts.apply) {
    return { hostScript, applied: false };
  }

  logInfo(
    `Adding host-relay bind-mount on ${parentHost} (mp${mpIndex}: ${storagePath} -> ${opts.mountPoint}) and restarting ${opts.guest}...`
  );
  await runRemote(deps.ssh, deps.inventory, parentHost, hostScript);

  logInfo(`Verifying mount on ${opts.guest}...`);
  const verify = await runRemote(deps.ssh, deps.inventory, opts.guest, `mountpoint -q '${opts.mountPoint}'`);
  if (verify.code !== 0) {
    throw new Error(`${opts.mountPoint} is not mounted after attaching`);
  }
  logInfo(`OK: ${opts.mountPoint} is mounted via host-relay (${opts.storage})`);

  return { hostScript, applied: true };
}
