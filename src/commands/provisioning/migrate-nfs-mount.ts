import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { parseNfsLines, parseMpEntries, nextFreeMpIndex } from '../../lib/nfs.ts';
import { logInfo } from '../../lib/log.ts';

export interface MigrateNfsMountOptions {
  guest: string;
  storage: string;
  apply?: boolean;
  fstabPath?: string;
  nfsServer?: string;
}

export async function runMigrateNfsMount(
  opts: MigrateNfsMountOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ guestScript: string; hostScript: string; applied: boolean }> {
  if (!/^[A-Za-z0-9._-]+$/.test(opts.storage)) {
    throw new Error(`--storage must contain only letters, digits, dots, hyphens, and underscores, got: ${opts.storage}`);
  }
  const fstabPath = opts.fstabPath ?? '/etc/fstab';
  const nfsServer = opts.nfsServer ?? deps.inventory.nfsServer;
  if (nfsServer === undefined) {
    throw new Error('nfsServer is not set -- run: bellhop set-config nfsServer <ip> --apply');
  }

  const guest = deps.inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || guest.type !== 'lxc') {
    throw new Error(`'${opts.guest}' is not an lxc guest in inventory`);
  }
  const parentHost = guest.host;

  logInfo(`Discovering ${opts.guest}'s current NFS mount from its fstab...`);
  const fstabResult = await runRemote(deps.ssh, deps.inventory, opts.guest, `cat '${fstabPath}' 2>/dev/null`);
  if (fstabResult.code !== 0) {
    throw new Error(`Failed to read fstab on ${opts.guest}`);
  }
  const mounts = parseNfsLines(fstabResult.stdout, nfsServer);
  if (mounts.length === 0) {
    throw new Error(`No NFS mount from ${nfsServer} found in ${opts.guest}'s fstab -- nothing to migrate`);
  }
  const { exportPath, mountPoint } = mounts[0];
  logInfo(`Found: ${exportPath} mounted at ${mountPoint}`);

  logInfo(`Looking up storage '${opts.storage}' on ${parentHost}...`);
  const storageResult = await runRemote(
    deps.ssh,
    deps.inventory,
    parentHost,
    `pvesh get /storage/${opts.storage} --output-format json`
  );
  if (storageResult.code !== 0) {
    throw new Error(`Failed to look up storage '${opts.storage}' on ${parentHost} -- does it exist?`);
  }
  const storageJson = JSON.parse(storageResult.stdout);
  const storageExport = storageJson.export ?? '';
  const storagePath = storageJson.path ?? '';
  if (!storagePath) {
    throw new Error(`Storage '${opts.storage}' has no 'path' -- is it type 'nfs'?`);
  }
  if (storageExport !== exportPath) {
    throw new Error(
      `Storage '${opts.storage}' exports '${storageExport}', but ${opts.guest} currently mounts '${exportPath}' -- refusing to migrate (wrong --storage?)`
    );
  }

  logInfo(`Finding next free mpN slot on vmid ${guest.vmid}...`);
  const configResult = await runRemote(deps.ssh, deps.inventory, parentHost, `pct config ${guest.vmid}`);
  if (configResult.code !== 0) {
    throw new Error(`Failed to read pct config for vmid ${guest.vmid} on ${parentHost}`);
  }
  const mpIndex = nextFreeMpIndex(parseMpEntries(configResult.stdout));
  logInfo(`Using mp${mpIndex}`);

  const guestScript = [
    'set -e',
    `umount '${mountPoint}' 2>/dev/null || true`,
    `if [ -f '${fstabPath}' ]; then`,
    `  awk -v mp='${mountPoint}' '$2 != mp' '${fstabPath}' > '${fstabPath}.new'`,
    `  mv '${fstabPath}.new' '${fstabPath}'`,
    'fi',
  ].join('\n');

  const hostScript = [`pct set ${guest.vmid} -mp${mpIndex} ${storagePath},mp=${mountPoint}`, `pct reboot ${guest.vmid}`].join('\n');

  if (!opts.apply) {
    return { guestScript, hostScript, applied: false };
  }

  logInfo(`Tearing down direct NFS mount on ${opts.guest} (${exportPath} at ${mountPoint})...`);
  await runRemote(deps.ssh, deps.inventory, opts.guest, guestScript);

  logInfo(`Adding host-relay bind-mount on ${parentHost} (mp${mpIndex}: ${storagePath} -> ${mountPoint}) and restarting ${opts.guest}...`);
  await runRemote(deps.ssh, deps.inventory, parentHost, hostScript);

  logInfo(`Verifying mount on ${opts.guest}...`);
  const verify = await runRemote(deps.ssh, deps.inventory, opts.guest, `mountpoint -q '${mountPoint}'`);
  if (verify.code !== 0) {
    throw new Error(`${mountPoint} is not mounted after migration`);
  }
  logInfo(`OK: ${mountPoint} is mounted via host-relay (${opts.storage})`);

  return { guestScript, hostScript, applied: true };
}
