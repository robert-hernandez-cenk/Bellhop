// Seeds a handful of already-finished jobs into the demo's own jobs
// database, so Job History and a job's own log page have something to show
// without the demo ever running a real job. See
// specs/014-web-ui-screenshots/research.md R5 and data-model.md's "Seeded
// job" table.
import Database from 'better-sqlite3';
import type { JobStore } from '../../src/web/jobs/job-store.ts';
import type { JobLog } from '../../src/web/jobs/job-log.ts';

// One fixed date so every seeded job's timestamps -- and any screenshot of
// them -- are reproducible across runs, never wall-clock-dependent.
const DEMO_JOBS_DATE = '2026-09-14';
const iso = (time: string) => `${DEMO_JOBS_DATE}T${time}.000Z`;

// Exported so the example-data guard (T004) can scan every seeded job's log
// text for a non-example hostname/IP -- every line below uses only the demo
// inventory's own names and RFC 5737 addresses.
export const DEMO_JOB_LOGS = {
  syncInventory: [
    'Querying pve1 for LXC/QEMU guests...',
    '  7 lxc guest(s), 0 qemu guest(s) found',
    'Querying pve2 for LXC/QEMU guests...',
    '  2 lxc guest(s), 1 qemu guest(s) found',
    'Reconciling guests against inventory/bellhop.db...',
    'New guests: 0',
    'Updated guests: 0',
    'Removed guests: 0',
    'Querying network interfaces on pve1...',
    '  pve1/vmbr0: alias=\'LAN\' active=true',
    '  pve1/vmbr1: alias=\'Guest LAN\' active=true',
    'Querying network interfaces on pve2...',
    '  pve2/vmbr0: alias=\'LAN\' active=true',
    'Bridges refreshed for 2/2 host(s)',
    'Querying storage pools on pve1...',
    'Querying storage pools on pve2...',
    'Storages refreshed for 2/2 host(s)',
    'nfsServer is 198.51.100.50 -- scanning /etc/fstab on each host...',
    'NFS fstab mounts refreshed for 2/2 host(s)',
    'sync-inventory completed successfully.',
  ].join('\n'),
  installApp: [
    'Resolving app source for \'jellyfin\'...',
    '  community-scripts/ProxmoxVE ct/jellyfin.sh',
    'Checking VMID 1003 on pve1 is available...',
    '  pct status 1003: not found',
    '  qm status 1003: not found',
    '  VMID 1003 is free',
    'Resolving pve1 authorized_keys for the new container...',
    '  1 key found, will be provisioned via var_ssh',
    'Selecting storage on pve1...',
    '  var_template_storage=local (vztmpl)',
    '  var_container_storage=local-lvm (rootdir)',
    'Running community-scripts installer (unattended)...',
    '  Creating LXC container 1003 (jellyfin)...',
    '  Container 1003 created',
    '  Installing Jellyfin inside container 1003...',
    '  Starting jellyfin.service...',
    '  jellyfin.service is active',
    'Container jellyfin is reachable at 198.51.100.3:8096',
    'Pushing pve1 authorized_keys into jellyfin...',
    '  authorized_keys written',
    'Recording jellyfin (vmid=1003 host=pve1 ip=198.51.100.3) in inventory...',
    'Syncing reverse proxy for jellyfin.example.com, media.example.com...',
    '  Caddyfile managed section updated, caddy reloaded',
    'Probing https://198.51.100.3:8096 for backend TLS...',
    '  no TLS on this port, insecureBackendTls left unset',
    'ssh root@198.51.100.3',
    'install-app completed successfully.',
  ].join('\n'),
  updateAll: [
    'Selected targets: pve1, pve2, proxy, auth, jellyfin, homeassistant, paperless-ngx, nextcloud, vaultwarden, grafana, pihole',
    'Probing package manager on pve1... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on pve2... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on proxy... apt',
    '  apt-get update && apt-get upgrade: 2 packages upgraded',
    'Probing package manager on auth... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on jellyfin... apt',
    '  apt-get update && apt-get upgrade: 1 package upgraded',
    'Probing package manager on homeassistant... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on paperless-ngx... apt',
    '  apt-get update && apt-get upgrade: 3 packages upgraded',
    'Probing package manager on nextcloud... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on vaultwarden... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'Probing package manager on grafana... apt',
    '  apt-get update && apt-get upgrade: 1 package upgraded',
    'Probing package manager on pihole... apt',
    '  apt-get update && apt-get upgrade: 0 packages upgraded',
    'update-all completed successfully.',
  ].join('\n'),
  updateApp: [
    'Resolving app source for \'nextcloud\'...',
    '  community-scripts/ProxmoxVE ct/nextcloud.sh',
    'Running ct/nextcloud.sh update inside nextcloud (vmid=1006 host=pve1)...',
    '  Connecting to pve1...',
    '  pct exec 1006 -- sh -c \'bash -c "$(curl -fsSL .../ct/nextcloud.sh)"\'',
    '  Exporting TERM=xterm, PHS_SILENT=1',
    '  Checking for available update...',
    '  Current version: 28.0.1, latest: 28.0.3',
    '  Updating Nextcloud...',
    '  occ maintenance:mode --on',
    '  apt-get update',
    'ERROR: Failed to fetch package lists (network unreachable inside the container)',
    '  occ maintenance:mode --off',
    'ERROR: Nextcloud update aborted -- occ upgrade exited with a non-zero status',
    'ERROR: nextcloud (vmid=1006 host=pve1) left in maintenance mode -- retry update-app once network access is restored',
    'update-app failed with exit code 1.',
  ].join('\n'),
} as const;

interface SeededJobDef {
  command: string;
  category: 'provisioning' | 'maintenance';
  target?: string;
  argsJson: string;
  status: 'success' | 'failed';
  exitCode: number;
  errorMessage?: string;
  log: string;
  startedAt: string;
  finishedAt: string;
}

const JOB_DEFS: SeededJobDef[] = [
  {
    command: 'sync-inventory',
    category: 'maintenance',
    argsJson: '{}',
    status: 'success',
    exitCode: 0,
    log: DEMO_JOB_LOGS.syncInventory,
    startedAt: iso('09:00:00'),
    finishedAt: iso('09:00:06'),
  },
  {
    command: 'install-app',
    category: 'provisioning',
    // Named after the guest it created, for a readable Job History row --
    // the real install-app operation targets the Proxmox host instead
    // (src/operations/provisioning.ts), since the guest doesn't exist until
    // apply finishes.
    target: 'jellyfin',
    argsJson: JSON.stringify({
      app: 'jellyfin',
      host: 'pve1',
      mid: 3,
      hostname: 'jellyfin',
      subdomains: 'jellyfin.example.com,media.example.com',
      port: '8096',
    }),
    status: 'success',
    exitCode: 0,
    log: DEMO_JOB_LOGS.installApp,
    startedAt: iso('09:05:00'),
    finishedAt: iso('09:08:32'),
  },
  {
    command: 'update-all',
    category: 'maintenance',
    argsJson: JSON.stringify({ all: true }),
    status: 'success',
    exitCode: 0,
    log: DEMO_JOB_LOGS.updateAll,
    startedAt: iso('09:15:00'),
    finishedAt: iso('09:16:47'),
  },
  {
    command: 'update-app',
    category: 'maintenance',
    target: 'nextcloud',
    argsJson: JSON.stringify({ guest: 'nextcloud', app: 'nextcloud' }),
    status: 'failed',
    exitCode: 1,
    errorMessage: 'update-app failed with exit code 1',
    log: DEMO_JOB_LOGS.updateApp,
    startedAt: iso('09:20:00'),
    finishedAt: iso('09:20:12'),
  },
];

// `jobsDbPath` is the same file `store` already opened -- JobStore exposes
// no way to write a caller-chosen started/finished timestamp (it always
// stamps `new Date().toISOString()`), so this opens a second, short-lived
// connection purely to overwrite those two columns after the fact, the
// least invasive way to get deterministic times without adding a test-only
// parameter to JobStore (research R5). Note: research.md's own wording also
// names a `created_at` column, but `JobStore`'s `jobs` table has no such
// column (only `started_at`/`finished_at` are ever null-until-set) -- there
// is nothing to overwrite for that. Synchronous end to end, so this returns
// nothing to await.
export function seedDemoJobs(store: JobStore, jobLog: JobLog, jobsDbPath: string, owner: string): void {
  const db = new Database(jobsDbPath);
  try {
    const setTimestamps = db.prepare(`UPDATE jobs SET started_at = ?, finished_at = ? WHERE id = ?`);
    for (const def of JOB_DEFS) {
      const id = store.createJob({
        command: def.command,
        category: def.category,
        target: def.target,
        argsJson: def.argsJson,
        triggeredByUsername: 'admin',
        owner,
      });
      const row = store.get(id);
      if (!row) throw new Error(`seedDemoJobs: could not read back job ${id} right after creating it`);
      jobLog.append(row.logFile, `${def.log}\n`);
      // markRunning then markFinished walks the same real status
      // transitions a live job goes through, so this job's row is
      // indistinguishable from one JobRunner itself produced -- only the
      // timestamps are overwritten afterward.
      store.markRunning(id);
      store.markFinished(id, { status: def.status, exitCode: def.exitCode, errorMessage: def.errorMessage });
      setTimestamps.run(def.startedAt, def.finishedAt, id);
    }
  } finally {
    db.close();
  }
}
