import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, resolveMid, stripCidr, type ResolvedMid } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { pickStorage } from '../../lib/storage.ts';
import { resolveNfsMountPath, buildNfsAttachScript } from '../../lib/nfs.ts';
import { readHostAuthorizedKeys, buildAuthorizedKeysWriteScript } from '../../lib/authorized-keys.ts';
import { logInfo, logWarn } from '../../lib/log.ts';

export interface CreateLxcOptions {
  host: string;
  mid: number;
  hostname: string;
  template: string;
  cores?: number;
  memory?: number;
  disk?: number;
  bridge?: string;
  // Operator-chosen rootfs storage (the web UI's Storage dropdown); falls
  // back to pickStorage's automatic selection when omitted, so the CLI
  // (which has no --storage flag) keeps working unchanged.
  storage?: string;
  // Both required together (validated at the top of runCreateLxc) or both
  // omitted -- an optional host-relay bind-mount attached right after the
  // guest is created, reusing attach-nfs-mount's own resolution/script
  // logic via src/lib/nfs.ts.
  nfsStorage?: string;
  nfsMountPoint?: string;
  apply?: boolean;
}

export function buildCreateLxcCommand(opts: CreateLxcOptions, mid: ResolvedMid, storage: string): string {
  const cores = opts.cores ?? 1;
  const memory = opts.memory ?? 512;
  const disk = opts.disk ?? 8;
  const bridge = opts.bridge ?? 'vmbr0';
  return (
    `pct create ${mid.vmid} ${shellQuote(opts.template)} ` +
    `--hostname ${shellQuote(opts.hostname)} --cores ${cores} --memory ${memory} ` +
    `--rootfs ${shellQuote(storage)}:${disk} ` +
    `--net0 name=eth0,bridge=${shellQuote(bridge)},ip=${shellQuote(mid.ip)},gw=${shellQuote(mid.gateway)} ` +
    `--start 1 && ` +
    // Proxmox's official LXC templates ship with postfix pre-installed (an
    // artifact of the template-build tooling defaulting to it as an MTA, not
    // something any guest or this toolkit needs). Left in place, its chroot
    // jail's device nodes
    // (/var/spool/postfix/dev/{random,urandom}) make the guest impossible to
    // later restore as unprivileged (mknod is refused inside the restricted
    // user namespace an unprivileged restore runs under). Purging it at
    // creation time means every guest this command produces is convertible
    // later without hitting that landmine. `apt-get purge` on an
    // already-absent package is a harmless no-op, so this stays safe even if
    // a future template drops postfix.
    // Guarded rather than bare: `pct exec` runs this without a shell, and it
    // is chained with && above, so on a non-apt template a bare apt-get would
    // make the whole command exit nonzero and report failure on a container
    // that was in fact created successfully. The guard only no-ops when
    // apt-get is genuinely absent (non-apt template) -- it does not swallow
    // a real purge failure on an apt-based template (dpkg lock, disk full,
    // corrupt package DB), which still fails the chain as it should.
    `pct exec ${mid.vmid} -- sh -c ${shellQuote('if command -v apt-get >/dev/null 2>&1; then apt-get purge -y postfix; fi')}`
  );
}

export async function runCreateLxc(
  opts: CreateLxcOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ command: string; mid: ResolvedMid; applied: boolean }> {
  if ((opts.nfsStorage && !opts.nfsMountPoint) || (!opts.nfsStorage && opts.nfsMountPoint)) {
    throw new Error('--nfs-storage and --nfs-mount-point must be given together');
  }
  if (opts.nfsStorage && !/^[A-Za-z0-9._-]+$/.test(opts.nfsStorage)) {
    throw new Error(`--nfs-storage must contain only letters, digits, dots, hyphens, and underscores, got: ${opts.nfsStorage}`);
  }
  if (opts.nfsMountPoint && !opts.nfsMountPoint.startsWith('/')) {
    throw new Error(`--nfs-mount-point must be an absolute path, got: ${opts.nfsMountPoint}`);
  }

  const host = deps.inventory.hosts.find((h) => h.name === opts.host);
  if (!host) {
    throw new Error(`Not a Proxmox host in inventory: ${opts.host}`);
  }
  const mid = resolveMid(deps.inventory, opts.host, opts.mid);
  const storage = opts.storage || pickStorage(host, ['rootdir', 'images']);
  const createCommand = buildCreateLxcCommand(opts, mid, storage);

  // Resolved in both dry-run and apply, mirroring resolveNfsMountPath below
  // -- so the previewed command is provably identical to what apply sends.
  const hostKeys = await readHostAuthorizedKeys(deps.ssh, deps.inventory, opts.host);
  const keysScript = hostKeys ? buildAuthorizedKeysWriteScript(mid.vmid, hostKeys) : undefined;

  let nfsScript: string | undefined;
  if (opts.nfsStorage && opts.nfsMountPoint) {
    const storagePath = await resolveNfsMountPath(deps.ssh, deps.inventory, host, opts.nfsStorage);
    // A freshly created guest has no existing bind-mounts, so mp0 is
    // always free -- unlike attach-nfs-mount, which scans pct config for
    // the next free index on a guest that may already have some.
    nfsScript = buildNfsAttachScript(mid.vmid, 0, storagePath, opts.nfsMountPoint);
  }

  let command = createCommand;
  if (keysScript) {
    command += `\n\n# --- provision operator SSH keys (separate remote call) ---\n${keysScript}`;
  } else {
    // Mirrors the keysScript comment above so a dry-run preview never
    // silently omits the SSH-keys step -- an operator previewing the
    // command otherwise has no way to tell whether keys will be
    // provisioned (the actual warning only fires at apply time).
    command += `\n\n# --- SSH keys: no authorized_keys found on ${opts.host}, skipping ---`;
  }
  if (nfsScript) command += `\n\n# --- attach NFS mount (separate remote call) ---\n${nfsScript}`;

  const applied = confirmOrDryRun(`Would run on ${opts.host}: ${command}`, opts.apply ?? false);
  if (applied) {
    const result = await runRemote(deps.ssh, deps.inventory, opts.host, createCommand);
    if (result.code !== 0) {
      throw new Error(`pct create failed on ${opts.host} (exit ${result.code}): ${result.stderr || result.stdout}`);
    }
    if (keysScript) {
      const keysResult = await runRemote(deps.ssh, deps.inventory, opts.host, keysScript);
      if (keysResult.code !== 0) {
        // Non-fatal: the guest already exists and works via pct exec
        // either way -- this is a convenience addition, not a hard
        // requirement, same precedent as a failed NFS attach below.
        logWarn(
          `Guest ${opts.hostname} created successfully (vmid ${mid.vmid}), but provisioning SSH keys failed: ${keysResult.stderr || keysResult.stdout}`
        );
      }
    } else {
      logWarn(`No authorized_keys found on host '${opts.host}'; skipping SSH key provisioning for ${opts.hostname}`);
    }
    if (nfsScript) {
      const nfsResult = await runRemote(deps.ssh, deps.inventory, opts.host, nfsScript);
      if (nfsResult.code !== 0) {
        throw new Error(
          `Guest ${opts.hostname} created successfully (vmid ${mid.vmid}), but attaching NFS mount failed: ${nfsResult.stderr || nfsResult.stdout} -- the guest was not rolled back. Run Sync Inventory, then use Attach NFS Mount to retry.`
        );
      }
    }
    logInfo(`Connect with: ssh root@${stripCidr(mid.ip)}`);
  }
  return { command, mid, applied };
}
