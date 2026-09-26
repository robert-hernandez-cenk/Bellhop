import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, resolveMid, stripCidr, checkVmidAvailable, type ResolvedMid } from '../../lib/targets.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { pickStorage, listBackupStorages } from '../../lib/storage.ts';
import { logInfo, logWarn } from '../../lib/log.ts';
import { saveInventory, refreshInventory } from '../../lib/inventory.ts';
import { runSyncCaddy } from '../networking/sync-caddy.ts';
import { runRenderStatusPage, statusPagePathSkipMessage } from '../networking/render-status-page.ts';
import { parseNet0, setNet0Ip, parseIpconfig0, setIpconfig0Ip } from '../../lib/guest-vpn.ts';
import { settingFix } from '../../lib/settings-hint.ts';
import { stringify } from 'yaml';

export interface MigrateGuestOptions {
  guest: string;
  toHost: string;
  mid?: number;
  backupStorage?: string;
  storage?: string;
  apply?: boolean;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface MigrateGuestResult {
  sourceScript: string;
  targetScript: string;
  mid: ResolvedMid;
  applied: boolean;
}

const VERIFY_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 3000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strips vzdump's compression extension off the archive path and appends
// .log, e.g. ".../vzdump-lxc-4012-....tar.zst" -> ".../vzdump-lxc-4012-....log"
// -- Proxmox's vzdump log sidecar *replaces* the archive's tar/vma+compression
// extension, it does not append onto the full archive filename the way the
// .notes sidecar does (that one genuinely is `<archive>.notes`).
export function archiveLogPath(archivePath: string): string {
  return archivePath.replace(/\.(tar|vma)(\.\w+)?$/, '.log');
}

// Every error thrown after the source guest is deliberately stopped (see
// the post-vzdump status-check/stop block below) must say so accurately --
// it is stopped, not "untouched", and nothing restarts it automatically.
// Centralized here so all such messages stay worded consistently.
function sourceStoppedNote(tool: 'pct' | 'qm', sourceHost: string, sourceVmid: number): string {
  return `the original guest on ${sourceHost} is stopped (not destroyed) -- restart it with \`${tool} start ${sourceVmid}\` if you're not retrying this migration`;
}

// Rewrites only the ip= field of the restored guest's net0 (LXC) /
// ipconfig0 (VM) config to the new host's derived IP, leaving every other
// field (gw=, hwaddr=, tag=, mtu=, firewall=, rate=, ...) exactly as
// restored from the backup. Never touches gw=: resolveMid returns the same
// gateway regardless of host role on this toolkit's single flat LAN, so a
// migration never legitimately needs to change it -- and for a guest
// deliberately routed through a VPN gateway guest (set-guest-vpn), silently
// resetting gw= back to the LAN gateway would un-VPN it without any
// indication that happened.
async function reconfigureGuestIp(
  ssh: SSHClient,
  inventory: Inventory,
  toHost: string,
  mid: ResolvedMid,
  guestType: 'lxc' | 'vm',
  guestName: string,
  sourceHost: string,
  sourceVmid: number
): Promise<void> {
  const tool = guestType === 'lxc' ? 'pct' : 'qm';
  const flag = guestType === 'lxc' ? '--net0' : '--ipconfig0';
  const fieldName = guestType === 'lxc' ? 'net0' : 'ipconfig0';

  const configResult = await runRemote(ssh, inventory, toHost, `${tool} config ${mid.vmid}`);
  if (configResult.code !== 0) {
    throw new Error(
      `Failed to read ${tool} config for vmid ${mid.vmid} on ${toHost} (exit ${configResult.code}): ${configResult.stderr || configResult.stdout} -- ${sourceStoppedNote(tool, sourceHost, sourceVmid)}`
    );
  }
  const rawValue = guestType === 'lxc' ? parseNet0(configResult.stdout) : parseIpconfig0(configResult.stdout);
  if (!rawValue) {
    throw new Error(
      `Restored guest vmid ${mid.vmid} on ${toHost} has no ${fieldName} in its config -- refusing to guess its network config; ${sourceStoppedNote(tool, sourceHost, sourceVmid)}, and the restored (unconfigured) guest on ${toHost} was left in place for inspection`
    );
  }
  const rewritten = guestType === 'lxc' ? setNet0Ip(rawValue, mid.ip) : setIpconfig0Ip(rawValue, mid.ip);

  const netResult = await runRemote(ssh, inventory, toHost, `${tool} set ${mid.vmid} ${flag} ${shellQuote(rewritten)}`);
  if (netResult.code !== 0) {
    throw new Error(
      `Failed to configure networking for vmid ${mid.vmid} on ${toHost} (exit ${netResult.code}): ${netResult.stderr || netResult.stdout} -- ${sourceStoppedNote(tool, sourceHost, sourceVmid)}`
    );
  }
}

async function waitForGuestRunning(
  ssh: SSHClient,
  inventory: Inventory,
  hostName: string,
  vmid: number,
  tool: 'pct' | 'qm',
  attempts: number,
  delayMs: number,
  sleepFn: (ms: number) => Promise<void>,
  sourceHost: string,
  sourceVmid: number
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runRemote(ssh, inventory, hostName, `${tool} status ${vmid}`);
    if (/status:\s*running/.test(result.stdout)) return;
    if (attempt < attempts - 1) await sleepFn(delayMs);
  }
  throw new Error(
    `${tool} status ${vmid} on '${hostName}' never reported running after ${attempts} attempt(s) -- the restored guest may have failed to start; ${sourceStoppedNote(tool, sourceHost, sourceVmid)}, check the new guest's status/logs first`
  );
}

export async function runMigrateGuest(
  opts: MigrateGuestOptions,
  deps: { ssh: SSHClient; inventory: Inventory; inventoryPath: string; sleepFn?: (ms: number) => Promise<void> }
): Promise<MigrateGuestResult> {
  const { ssh, inventory } = deps;

  const guest = inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || (guest.type !== 'lxc' && guest.type !== 'vm')) {
    throw new Error(`'${opts.guest}' is not an lxc/vm guest in inventory`);
  }
  const toHostEntry = inventory.hosts.find((h) => h.name === opts.toHost);
  if (!toHostEntry) {
    throw new Error(`Not a Proxmox host in inventory: ${opts.toHost}`);
  }
  const sourceHostEntry = inventory.hosts.find((h) => h.name === guest.host);
  if (!sourceHostEntry) {
    throw new Error(`The recorded host for '${opts.guest}' ('${guest.host}') is not a Proxmox host in inventory`);
  }
  // A VPN gateway guest's IP is what every other guest routed through it
  // (set-guest-vpn's gw=) points at -- migrating it changes that IP and
  // would silently orphan every dependent guest's routing, with no
  // reconciliation step in this command to fix them back up. Out of scope
  // here, same spirit as set-guest-vpn's own refusal to route a gateway
  // through a gateway.
  if (guest.vpnGateway) {
    throw new Error(
      `'${opts.guest}' is a VPN gateway (vpnGateway: ${guest.vpnGateway}) -- refusing to migrate it, since other guests may be routed through its current IP via set-guest-vpn and migrating it would silently orphan them`
    );
  }

  const midArg = opts.mid ?? guest.vmid % 1000;
  const mid = resolveMid(inventory, opts.toHost, midArg);
  // Same host is only a no-op when the derived vmid is *also* unchanged --
  // a same-host renumber (a different --mid, or an explicit --mid equal to
  // the current one's suffix but a different host role... which can't
  // actually happen, since a host's role is fixed) is a legitimate use of
  // this command's backup/restore-under-a-new-vmid mechanism, not a refusal
  // case. Checked here, after resolveMid, rather than by comparing
  // opts.toHost/guest.host alone, so it actually reflects whether anything
  // would change.
  if (opts.toHost === guest.host && mid.vmid === guest.vmid) {
    throw new Error(`'${opts.guest}' is already vmid ${guest.vmid} on '${opts.toHost}' -- nothing to migrate`);
  }

  const backupStorage = opts.backupStorage ?? inventory.backupStorage;
  if (backupStorage === undefined) {
    throw new Error(
      `backupStorage is not set -- ${settingFix('backupStorage', '<storage-id>')}, or pass --backup-storage`
    );
  }
  // Checked against whichever source won above (flag or inventory
  // fallback) -- validating only opts.backupStorage would leave the
  // inventory-sourced value unchecked, relying only on the existence check
  // below to incidentally catch anything malformed.
  if (!/^[A-Za-z0-9._-]+$/.test(backupStorage)) {
    throw new Error(
      `--backup-storage must contain only letters, digits, dots, hyphens, and underscores, got: ${backupStorage}`
    );
  }
  // Only an `nfs`-type storage is guaranteed to be mounted identically on
  // both hosts (cluster-shared /etc/pve storage.cfg, per migrate-nfs-mount's
  // existing --storage note in CLAUDE.md) -- a same-named `dir` storage
  // like `local` merely happens to exist on both hosts, but each is an
  // independent per-host directory, so a backup vzdump writes there on the
  // source host would not be visible to restore on the target host.
  const sourceMatch = listBackupStorages(sourceHostEntry).find((s) => s.name === backupStorage && s.type === 'nfs');
  const targetMatch = listBackupStorages(toHostEntry).find((s) => s.name === backupStorage && s.type === 'nfs');
  if (!sourceMatch || !targetMatch) {
    throw new Error(
      `--backup-storage '${backupStorage}' must be an active, backup-capable, cluster-shared ('nfs'-type) storage present on both '${guest.host}' and '${opts.toHost}'`
    );
  }

  await checkVmidAvailable(ssh, inventory, opts.toHost, mid.vmid);

  const tool = guest.type === 'lxc' ? 'pct' : 'qm';
  const targetStorage = opts.storage || pickStorage(toHostEntry, guest.type === 'lxc' ? ['rootdir', 'images'] : ['images']);

  const backupCommand = `vzdump ${guest.vmid} --storage ${backupStorage} --mode stop --compress zstd`;
  // The exact rewritten net0/ipconfig0 value is only known at apply time --
  // it depends on reading the *restored* guest's own config on ${opts.toHost}
  // and rewriting just its ip= field, the same reason the restore line below
  // can't show a real archive path ahead of time either.
  const netPreviewLine =
    guest.type === 'lxc'
      ? `${tool} set ${mid.vmid} --net0 <ip= rewritten to ${mid.ip}, every other field (gw=, hwaddr=, tag=, ...) preserved from the restored config>`
      : `${tool} set ${mid.vmid} --ipconfig0 <ip= rewritten to ${mid.ip}, every other field (gw=, ...) preserved from the restored config>`;

  const sourceScript = [
    backupCommand,
    `# then, if still running (vzdump --mode stop restarts a guest that was running before the backup): ${tool} stop ${guest.vmid}`,
    `# then, once the new guest is verified running on ${opts.toHost}:`,
    `${tool} destroy ${guest.vmid}`,
  ].join('\n');
  const targetScript = [
    `${tool} restore ${mid.vmid} <archive path reported by vzdump above> --storage ${targetStorage}`,
    netPreviewLine,
    `${tool} start ${mid.vmid}`,
  ].join('\n');

  const applied = confirmOrDryRun(
    `Would migrate '${opts.guest}' from '${guest.host}' (vmid ${guest.vmid}) to '${opts.toHost}' (vmid ${mid.vmid}, ip ${stripCidr(mid.ip)}):\n--- on ${guest.host} ---\n${sourceScript}\n--- on ${opts.toHost} ---\n${targetScript}`,
    opts.apply ?? false
  );
  if (!applied) {
    return { sourceScript, targetScript, mid, applied: false };
  }

  // Every test call injects a fake sleepFn via opts (never deps), so opts
  // wins; deps.sleepFn is kept as a fallback for the exact deps signature
  // Tasks 3-6 share, though nothing currently populates it.
  const sleepFn = opts.sleepFn ?? deps.sleepFn ?? defaultSleep;

  logInfo(`Backing up '${opts.guest}' (vmid ${guest.vmid}) on ${guest.host}...`);
  const backupResult = await runRemote(ssh, inventory, guest.host, backupCommand);
  if (backupResult.code !== 0) {
    throw new Error(`vzdump failed on ${guest.host} (exit ${backupResult.code}): ${backupResult.stderr || backupResult.stdout}`);
  }
  // VERIFY LIVE: pinned against Proxmox's documented/observed vzdump log
  // format ("INFO: creating vzdump archive '<path>'"), not yet confirmed
  // against this repo's own real vzdump output -- recheck against a real
  // vzdump run if this ever mismatches.
  const archiveMatch = backupResult.stdout.match(/creating vzdump archive '([^']+)'/);
  if (!archiveMatch) {
    throw new Error(
      `Could not find the created archive path in vzdump's output on ${guest.host}; nothing on ${opts.toHost} was touched. vzdump output:\n${backupResult.stdout}`
    );
  }
  const archivePath = archiveMatch[1];

  // `vzdump --mode stop` restarts the guest afterward if it was running
  // before the backup (documented/observed Proxmox behavior) -- so it may
  // well be running again right now, even though it was stopped for the
  // backup itself. It must be fully stopped before restore begins on
  // ${opts.toHost}: otherwise both copies could end up running
  // simultaneously (the old one here, the new one once started below), and
  // any NFS host-relay bind-mount (mpN) the guest carries would reattach on
  // the target automatically, risking two live instances writing to the
  // same NAS share at once. This closes that window for the rest of the
  // migration, not just right before the final destroy step.
  const sourceStatusResult = await runRemote(ssh, inventory, guest.host, `${tool} status ${guest.vmid}`);
  if (sourceStatusResult.code !== 0) {
    // I1: a non-zero exit here means the probe itself failed (a transient
    // lock right after vzdump, an unparsed/empty output, ...) -- it is NOT
    // evidence the guest is stopped. Silently falling through to "not
    // running" here would reopen the exact dual-run risk this whole check
    // exists to prevent, just now failing silently instead of loudly. If we
    // can't prove the source guest is stopped, refuse to proceed rather
    // than guess.
    throw new Error(
      `Failed to check whether '${opts.guest}' (vmid ${guest.vmid}) is still running on ${guest.host} after backup (exit ${sourceStatusResult.code}): ${sourceStatusResult.stderr || sourceStatusResult.stdout} -- refusing to proceed to restore without confirming the source guest is stopped, to avoid both copies running simultaneously`
    );
  }
  if (/status:\s*running/.test(sourceStatusResult.stdout)) {
    logInfo(`'${opts.guest}' (vmid ${guest.vmid}) is running again after backup -- stopping it on ${guest.host} before restore begins...`);
    const stopResult = await runRemote(ssh, inventory, guest.host, `${tool} stop ${guest.vmid}`);
    if (stopResult.code !== 0) {
      throw new Error(
        `Failed to stop '${opts.guest}' (vmid ${guest.vmid}) on ${guest.host} after backup (exit ${stopResult.code}): ${stopResult.stderr || stopResult.stdout} -- refusing to proceed to restore while the source guest might still be running, to avoid both copies running simultaneously`
      );
    }
  }

  logInfo(`Restoring '${opts.guest}' as vmid ${mid.vmid} on ${opts.toHost}...`);
  const restoreCommand = `${tool} restore ${mid.vmid} ${shellQuote(archivePath)} --storage ${targetStorage}`;
  const restoreResult = await runRemote(ssh, inventory, opts.toHost, restoreCommand);
  if (restoreResult.code !== 0) {
    throw new Error(
      `${tool} restore failed on ${opts.toHost} (exit ${restoreResult.code}): ${restoreResult.stderr || restoreResult.stdout} -- ${sourceStoppedNote(tool, guest.host, guest.vmid)}, and its backup remains at ${archivePath}`
    );
  }

  logInfo(`Reconfiguring networking for vmid ${mid.vmid} on ${opts.toHost} (rewriting only ip=, preserving every other field)...`);
  await reconfigureGuestIp(ssh, inventory, opts.toHost, mid, guest.type, opts.guest, guest.host, guest.vmid);

  const startResult = await runRemote(ssh, inventory, opts.toHost, `${tool} start ${mid.vmid}`);
  if (startResult.code !== 0) {
    throw new Error(
      `${tool} start failed for vmid ${mid.vmid} on ${opts.toHost} (exit ${startResult.code}): ${startResult.stderr || startResult.stdout} -- ${sourceStoppedNote(tool, guest.host, guest.vmid)}`
    );
  }

  logInfo(`Waiting for vmid ${mid.vmid} on ${opts.toHost} to report running...`);
  await waitForGuestRunning(ssh, inventory, opts.toHost, mid.vmid, tool, VERIFY_ATTEMPTS, VERIFY_INTERVAL_MS, sleepFn, guest.host, guest.vmid);

  logInfo(`Verified -- destroying original '${opts.guest}' (vmid ${guest.vmid}) on ${guest.host}...`);
  const destroyResult = await runRemote(ssh, inventory, guest.host, `${tool} destroy ${guest.vmid}`);
  if (destroyResult.code !== 0) {
    logWarn(
      `'${opts.guest}' migrated successfully to ${opts.toHost} (vmid ${mid.vmid}), but destroying the original guest (vmid ${guest.vmid}) on ${guest.host} failed (exit ${destroyResult.code}): ${destroyResult.stderr || destroyResult.stdout} -- clean it up by hand`
    );
  }

  const cleanupResult = await runRemote(
    ssh,
    inventory,
    guest.host,
    `rm -f ${shellQuote(archivePath)} ${shellQuote(`${archivePath}.notes`)} ${shellQuote(archiveLogPath(archivePath))}`
  );
  if (cleanupResult.code !== 0) {
    logWarn(
      `Failed to clean up backup archive ${archivePath} on ${guest.host}: ${cleanupResult.stderr || cleanupResult.stdout} -- remove it by hand`
    );
  }

  // Issue #16: this save lands at the end of a multi-minute remote pipeline,
  // and nothing refreshes inventory mid-job (the MCP process has no
  // per-request reload the way the web service does). Reload from disk first
  // (in place -- `inventory` is deps.inventory) and derive the new guests
  // array from that fresh copy, so an edit another process made meanwhile (a
  // Dashboard/Settings change, a CLI run) isn't silently reverted by a
  // wholesale save from the job-start snapshot.
  refreshInventory(inventory, deps.inventoryPath);
  const newIp = stripCidr(mid.ip);
  const guests = inventory.guests.map((g) =>
    g.name === opts.guest ? { ...g, host: opts.toHost, vmid: mid.vmid, ip: newIp } : g
  );
  saveInventory(deps.inventoryPath, { ...inventory, guests });
  inventory.guests = guests;

  if (guest.subdomains && guest.subdomains.length > 0) {
    logInfo(`Pushing the new IP for '${opts.guest}' (${newIp}) live via Caddy...`);
    await runSyncCaddy({ apply: true }, { ssh, inventory });
    // Same opt-in behavior as syncCaddyLive (src/web/caddy-sync.ts): an
    // operator who hasn't configured statusPagePath never gets an
    // index.html write attempted, and skipping it is not a failure here
    // either -- the Caddy config update above is what actually matters for
    // the migrated guest's subdomains to keep working.
    if (inventory.statusPagePath !== undefined) {
      await runRenderStatusPage({ apply: true }, { ssh, inventory }, stringify(inventory));
    } else {
      logInfo(statusPagePathSkipMessage());
    }
  }

  logInfo(`'${opts.guest}' is now on '${opts.toHost}' at ${newIp} (vmid ${mid.vmid}). Connect with: ssh root@${newIp}`);
  return { sourceScript, targetScript, mid, applied: true };
}
