import { Command } from 'commander';
import path from 'node:path';
import { stringify } from 'yaml';
import dotenv from 'dotenv';
import { authentikConfig, authentikConfigured } from './lib/authentik-config.ts';
import { logError, logInfo } from './lib/log.ts';
import { Ssh2SSHClient } from './lib/ssh-client.ts';
import { loadInventory, saveInventory } from './lib/inventory.ts';
import { dataDir, inventoryPath } from './lib/paths.ts';
import { runAuditNfsMounts, formatAuditNfsMounts } from './commands/maintenance/audit-nfs-mounts.ts';
import { runImportYamlInventory } from './commands/maintenance/import-yaml-inventory.ts';
import { runSyncInventory, formatSyncInventory } from './commands/maintenance/sync-inventory.ts';
import { runUpdateAll, formatUpdateAll } from './commands/maintenance/update-all.ts';
import { runUpdateApp } from './commands/maintenance/update-app.ts';
import { runGuestPower } from './commands/maintenance/guest-power.ts';
import { runSyncSshKeys, formatSyncSshKeysResult } from './commands/maintenance/sync-ssh-keys.ts';
import { runPushSshKey, formatPushSshKeyResult } from './commands/maintenance/push-ssh-key.ts';
import { runSetConfig } from './commands/maintenance/set-config.ts';
import { runSyncCaddy } from './commands/networking/sync-caddy.ts';
import { runRenderStatusPage } from './commands/networking/render-status-page.ts';
import { runSyncAuthentik, formatSyncAuthentik, syncAuthentikFailed } from './commands/networking/sync-authentik.ts';
import { runOidcCredentials, formatOidcCredentials } from './commands/networking/oidc-credentials.ts';
import { runAdoptOidcClient, formatAdoptOidcClient } from './commands/networking/adopt-oidc-client.ts';
import { runPruneAcmeChallenges, formatPruneAcmeChallenges } from './commands/networking/prune-acme-challenges.ts';
import { buildCloudflareClient } from './lib/cloudflare-client.ts';
import { RealAuthentikClient, UnconfiguredAuthentikClient } from './lib/authentik-client.ts';
import type { AuthentikClient } from './lib/authentik-client.ts';
import { runAttachNfsMount } from './commands/provisioning/attach-nfs-mount.ts';
import { runConfigureGuest } from './commands/provisioning/configure-guest.ts';
import { runCreateLxc } from './commands/provisioning/create-lxc.ts';
import { runCreateVm } from './commands/provisioning/create-vm.ts';
import { runInstallApp } from './commands/provisioning/install-app.ts';
import { runDeployVpnGateway } from './commands/provisioning/deploy-vpn-gateway.ts';
import { runSetGuestVpn } from './commands/provisioning/set-guest-vpn.ts';
import { runMigrateNfsMount } from './commands/provisioning/migrate-nfs-mount.ts';
import { runDeleteGuest } from './commands/provisioning/delete-guest.ts';
import { runMigrateGuest } from './commands/provisioning/migrate-guest.ts';
import type { TargetSelector } from './lib/targets.ts';

// Mirrors src/web/server.ts: the gitignored data/authentik.env supplies
// AUTHENTIK_API_URL/AUTHENTIK_API_TOKEN plus the AUTHENTIK_* overrides read
// by authentikConfig(). Loading it here too is what keeps a CLI
// sync-authentik run and a web-triggered one from silently disagreeing about
// group names, the outpost, or the flow slugs. A missing file is a silent
// no-op (dotenv.config never throws).
dotenv.config({ path: path.join(dataDir(), 'authentik.env'), quiet: true });

// Mirrors src/web/server.ts: the gitignored data/cloudflare-api.env supplies
// CLOUDFLARE_DNS_API_TOKEN for prune-acme-challenges (issue #162). Not
// data/cloudflare.env -- that is the cloudflare-ddns container's answer file,
// which nothing in src/ reads. A missing file is a silent no-op.
dotenv.config({ path: path.join(dataDir(), 'cloudflare-api.env'), quiet: true });
export function fstabPath(): string | undefined {
  return process.env.FSTAB_PATH;
}

export function caddyfilePath(): string | undefined {
  return process.env.CADDYFILE_PATH;
}

export function nfsServer(): string | undefined {
  return process.env.NFS_SERVER;
}

// Mirrors src/web/server.ts's buildAuthentikClient(). Both AUTHENTIK_API_URL
// and AUTHENTIK_API_TOKEN come either from the operator's own shell or from
// data/authentik.env, loaded above. Delegates the configured/not-configured
// decision to authentikConfigured() so it lives in exactly one place -- the
// non-null assertions below are safe because authentikConfigured() already
// checked both vars against the same process.env this file reads.
export function buildAuthentikClient(): AuthentikClient {
  if (!authentikConfigured()) return new UnconfiguredAuthentikClient();
  return new RealAuthentikClient(process.env.AUTHENTIK_API_URL!, process.env.AUTHENTIK_API_TOKEN!, authentikConfig());
}

export function parsePositiveInt(value: string, flag: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`);
  }
  return parseInt(value, 10);
}

export function action<T extends unknown[]>(
  fn: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  };
}

export const program = new Command();

program
  .name('bellhop')
  .description('CLI toolkit for managing a Proxmox homelab cluster over SSH')
  .version('0.1.0');

program
  .command('audit-nfs-mounts')
  .description('Read-only report of NFS shares mounted across lxc guests')
  .option('--host <name>', 'audit only this lxc guest')
  .action(
    action(async (opts: { host?: string }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runAuditNfsMounts(opts, { ssh, inventory });
      console.log(formatAuditNfsMounts(result));
    })
  );

program
  .command('sync-inventory')
  .description("Reconcile inventory/bellhop.db guests and each host's bridges with live Proxmox state")
  .option('--apply', 'write the reconciled inventory (default: dry run)')
  .action(
    action(async (opts: { apply?: boolean }) => {
      const invPath = inventoryPath();
      const inventory = loadInventory(invPath);
      const ssh = new Ssh2SSHClient();
      const result = await runSyncInventory({ ...opts, fstabPath: fstabPath(), nfsServer: nfsServer() }, { ssh, inventory });
      console.log(formatSyncInventory(result));
      if (!opts.apply) {
        logInfo(`[DRY RUN] Not writing ${invPath}. Pass --apply to write these changes.`);
        return;
      }
      saveInventory(invPath, { ...inventory, guests: result.guests, hosts: result.hosts });
      logInfo(`Wrote ${invPath}`);
    })
  );

program
  .command('import-yaml-inventory')
  .description('One-time migration: import an existing hosts.yaml into a new SQLite inventory database')
  .requiredOption('--yaml-path <path>', 'path to the existing hosts.yaml')
  .requiredOption('--db-path <path>', 'path to the new SQLite database to create')
  .option('--apply')
  .action(
    action(async (opts: { yamlPath: string; dbPath: string; apply?: boolean }) => {
      const { inventory, applied } = await runImportYamlInventory(opts);
      if (!applied) {
        logInfo(
          `[DRY RUN] Would import ${inventory.hosts.length} host(s), ${inventory.guests.length} guest(s) from ${opts.yamlPath} into ${opts.dbPath}`
        );
        return;
      }
      logInfo(
        `Imported ${inventory.hosts.length} host(s), ${inventory.guests.length} guest(s) from ${opts.yamlPath} into ${opts.dbPath}`
      );
    })
  );

program
  .command('set-config')
  .description('Set or clear one inventory-wide setting (nfsServer, backupStorage, dnsServer, statusPagePath)')
  .argument('<key>', 'the setting to change')
  .argument('[value]', 'the new value (omit with --unset)')
  .option('--unset', 'clear the setting instead of setting it')
  .option('--apply', 'write the change (default: dry run)')
  .action(
    action(async (key: string, value: string | undefined, opts: { unset?: boolean; apply?: boolean }) => {
      const invPath = inventoryPath();
      const result = runSetConfig({ key, value, ...opts }, { inventoryPath: invPath });
      if (!result.applied) return;
      logInfo(result.value === undefined ? `Cleared ${result.key} in ${invPath}` : `Set ${result.key} to ${result.value} in ${invPath}`);
    })
  );

program
  .command('update-all')
  .description('Update OS packages on selected host(s)/guest(s)')
  .option('--host <name>', 'target a single host or guest')
  .option('--all', 'target every host and guest')
  .option('--group <pve|lxc|vm>', 'target every entry of one type')
  .action(
    action(async (opts: { host?: string; all?: boolean; group?: 'pve' | 'lxc' | 'vm' }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      let selector: TargetSelector;
      if (opts.host) selector = { host: opts.host };
      else if (opts.group) selector = { group: opts.group };
      else if (opts.all) selector = { all: true };
      else throw new Error('Specify one of --host, --all, or --group');
      const result = await runUpdateAll(selector, { ssh, inventory });
      console.log(formatUpdateAll(result));
      if (result.failConnect.length > 0 || result.failCommand.length > 0 || result.failUnknownPm.length > 0) {
        process.exitCode = 1;
      }
    })
  );

program
  .command('update-app')
  .description('Re-run a community-scripts install script inside an existing guest to trigger its update path')
  .requiredOption('--guest <name>')
  .requiredOption('--app <script-name>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; app: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const { script, ran, result } = await runUpdateApp(opts, { ssh, inventory });
      if (!ran) {
        logInfo(`[DRY RUN] Would run on ${opts.guest}:`);
        console.log(script);
        return;
      }
      logInfo(`Ran on ${opts.guest}: update ${opts.app} (exit code ${result!.code})`);
      if (result!.stdout) console.log(result!.stdout);
      if (result!.stderr) console.error(result!.stderr);
      if (result!.code !== 0) {
        process.exitCode = 1;
      }
    })
  );

program
  .command('guest-power')
  .description('Start or shut down an lxc/vm guest')
  .requiredOption('--guest <name>')
  .requiredOption('--state <start|shutdown>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; state: 'start' | 'shutdown'; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const { command, ran, result } = await runGuestPower(opts, { ssh, inventory });
      if (!ran) {
        logInfo(`[DRY RUN] Would run on ${opts.guest}'s parent host:`);
        console.log(command);
        return;
      }
      logInfo(`Ran on ${opts.guest}'s parent host: ${command} (exit code ${result!.code})`);
      if (result!.stdout) console.log(result!.stdout);
      if (result!.stderr) console.error(result!.stderr);
      if (result!.code !== 0) {
        process.exitCode = 1;
      }
    })
  );

program
  .command('sync-ssh-keys')
  .description("Ensure each lxc guest's authorized_keys includes its parent host's current keys")
  .option('--host <name>', 'target only this lxc guest')
  .option('--apply', 'write changes (default: dry run)')
  .action(
    action(async (opts: { host?: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runSyncSshKeys(opts, { ssh, inventory });
      console.log(formatSyncSshKeysResult(result));
    })
  );

program
  .command('push-ssh-key')
  .description('Ensure one explicit SSH public key is present on the given lxc guest(s)')
  .requiredOption('--key <key>', 'the SSH public key to push')
  .option('--guest <name>', 'target guest (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--apply', 'write changes (default: dry run)')
  .action(
    action(async (opts: { key: string; guest: string[]; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runPushSshKey({ key: opts.key, guests: opts.guest, apply: opts.apply }, { ssh, inventory });
      console.log(formatPushSshKeyResult(result));
    })
  );

program
  .command('sync-caddy')
  .description('Generate and write Caddy reverse_proxy blocks from inventory subdomains')
  .option('--apply', 'write the Caddyfile and reload Caddy (default: dry run)')
  .action(
    action(async (opts: { apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runSyncCaddy({ ...opts, caddyfilePath: caddyfilePath() }, { ssh, inventory });
      if (!result.applied) {
        logInfo(`[DRY RUN] Generated managed block for ${result.caddyHost}:`);
        console.log(result.block);
        return;
      }
      logInfo(`Wrote managed block to ${result.caddyHost}`);
    })
  );

program
  .command('sync-authentik')
  .description("Reconcile Authentik Providers/Applications/policy bindings with inventory's authGroup entries")
  .option('--apply', 'create/update/delete Authentik objects (default: dry run)')
  .action(
    action(async (opts: { apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const authentik = buildAuthentikClient();
      const result = await runSyncAuthentik({ ...opts }, { authentik, inventory });
      console.log(formatSyncAuthentik(result));
      if (!opts.apply) {
        logInfo('[DRY RUN] Not modifying Authentik. Pass --apply to create/update/delete these objects.');
      }
      // Same partial-failure pattern as prune-acme-challenges: everything
      // that could be applied was, and the report above says what was not.
      if (syncAuthentikFailed(result)) {
        process.exitCode = 1;
      }
    })
  );

program
  .command('oidc-credentials <entry>')
  .description("Print an OIDC-gated entry's issuer, client ID, and client secret, read live from Authentik")
  .action(
    action(async (entry: string) => {
      const inventory = loadInventory(inventoryPath());
      const authentik = buildAuthentikClient();
      const result = await runOidcCredentials(entry, { authentik, inventory });
      console.log(formatOidcCredentials(result));
    })
  );

program
  .command('adopt-oidc-client <entry>')
  .description(
    "Adopt a hand-made Authentik OpenID client at an OIDC-gated entry's slug as Bellhop-managed, without rotating its client ID or secret"
  )
  .option('--apply', 'adopt the client for real (default: dry run)')
  .action(
    action(async (entry: string, opts: { apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const authentik = buildAuthentikClient();
      const result = await runAdoptOidcClient({ entry, apply: opts.apply }, { authentik, inventory });
      console.log(formatAdoptOidcClient(result));
      if (!opts.apply) {
        logInfo('[DRY RUN] Not modifying Authentik. Pass --apply to adopt this client.');
      }
    })
  );

program
  .command('prune-acme-challenges')
  .description("Delete _acme-challenge TXT records untouched for over 24h from the inventory domain's Cloudflare zone")
  .option('--apply', 'delete the stale records (default: dry run)')
  .action(
    action(async (opts: { apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const cloudflare = buildCloudflareClient();
      const result = await runPruneAcmeChallenges({ ...opts }, { cloudflare, inventory });
      console.log(formatPruneAcmeChallenges(result));
      if (!opts.apply) {
        logInfo('[DRY RUN] Not modifying Cloudflare. Pass --apply to delete these records.');
      }
      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    })
  );

program
  .command('render-status-page')
  .description('Regenerate the LAN-only status page (bellhop.db + active Caddyfile) served on the Caddy host')
  .option('--apply', 'write the status page (default: dry run)')
  .action(
    action(async (opts: { apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const inventorySnapshot = stringify(inventory);
      const ssh = new Ssh2SSHClient();
      const result = await runRenderStatusPage({ ...opts, caddyfilePath: caddyfilePath() }, { ssh, inventory }, inventorySnapshot);
      if (!result.applied) {
        logInfo(`[DRY RUN] Generated status page for ${result.caddyHost}:`);
        console.log(result.html);
        return;
      }
      logInfo(`Wrote status page to ${result.caddyHost}`);
    })
  );

program
  .command('attach-nfs-mount')
  .description('Attach an lxc guest to an existing NFS storage entry via a host-relay bind-mount')
  .requiredOption('--guest <name>')
  .requiredOption('--storage <storage-id>')
  .requiredOption('--mount-point <path>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; storage: string; mountPoint: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runAttachNfsMount(opts, { ssh, inventory });
      if (!result.applied) {
        logInfo(
          `[DRY RUN] Would run on ${opts.guest}'s parent host (adds the bind-mount and RESTARTS ${opts.guest} -- brief outage):`
        );
        console.log(result.hostScript);
      }
    })
  );

program
  .command('configure-guest')
  .description('Install packages and/or add an SSH public key on an existing guest')
  .requiredOption('--guest <name>')
  .option('--packages <pkgs>', 'space-separated package list')
  .option('--ssh-key <key>', 'public key to ensure is present in authorized_keys')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; packages?: string; sshKey?: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      await runConfigureGuest(opts, { ssh, inventory });
    })
  );

program
  .command('create-lxc')
  .description('Create a new LXC container on a Proxmox host')
  .requiredOption('--host <pve-host>')
  .requiredOption('--mid <n>', 'machine ID 1-254', (v) => parsePositiveInt(v, '--mid'))
  .requiredOption('--hostname <name>')
  .requiredOption('--template <template>')
  .option('--cores <n>', 'CPU cores', (v) => parsePositiveInt(v, '--cores'))
  .option('--memory <mb>', 'memory in MB', (v) => parsePositiveInt(v, '--memory'))
  .option('--disk <gb>', 'disk size in GB', (v) => parsePositiveInt(v, '--disk'))
  .option('--bridge <bridge>')
  .option('--nfs-storage <name>')
  .option('--nfs-mount-point <path>')
  .option('--apply')
  .action(
    action(
      async (opts: {
        host: string;
        mid: number;
        hostname: string;
        template: string;
        cores?: number;
        memory?: number;
        disk?: number;
        bridge?: string;
        nfsStorage?: string;
        nfsMountPoint?: string;
        apply?: boolean;
      }) => {
        const inventory = loadInventory(inventoryPath());
        const ssh = new Ssh2SSHClient();
        await runCreateLxc(opts, { ssh, inventory });
      }
    )
  );

program
  .command('create-vm')
  .description('Create a new VM on a Proxmox host')
  .requiredOption('--host <pve-host>')
  .requiredOption('--mid <n>', 'machine ID 1-254', (v) => parsePositiveInt(v, '--mid'))
  .requiredOption('--name <name>')
  .option('--cores <n>', 'CPU cores', (v) => parsePositiveInt(v, '--cores'))
  .option('--memory <mb>', 'memory in MB', (v) => parsePositiveInt(v, '--memory'))
  .option('--disk-storage <storage>')
  .option('--disk <gb>', 'disk size in GB', (v) => parsePositiveInt(v, '--disk'))
  .option('--bridge <bridge>')
  .option('--cloud-init', 'attach a cloud-init drive so --ipconfig0 takes effect')
  .option('--apply')
  .action(
    action(
      async (opts: {
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
      }) => {
        const inventory = loadInventory(inventoryPath());
        const ssh = new Ssh2SSHClient();
        await runCreateVm(opts, { ssh, inventory });
      }
    )
  );

program
  .command('install-app')
  .description('Create a new LXC container by running a community-scripts install script unattended')
  .requiredOption('--host <pve-host>')
  .requiredOption('--mid <n>', 'machine ID 1-254', (v) => parsePositiveInt(v, '--mid'))
  .requiredOption('--app <script-name>')
  .requiredOption('--hostname <name>')
  .option('--cores <n>', 'CPU cores', (v) => parsePositiveInt(v, '--cores'))
  .option('--memory <mb>', 'memory in MB', (v) => parsePositiveInt(v, '--memory'))
  .option('--disk <gb>', 'disk size in GB', (v) => parsePositiveInt(v, '--disk'))
  .option('--bridge <bridge>')
  .option('--nfs-storage <name>')
  .option('--nfs-mount-point <path>')
  .option('--apply')
  .action(
    action(
      async (opts: {
        host: string;
        mid: number;
        app: string;
        hostname: string;
        cores?: number;
        memory?: number;
        disk?: number;
        bridge?: string;
        nfsStorage?: string;
        nfsMountPoint?: string;
        apply?: boolean;
      }) => {
        const inventory = loadInventory(inventoryPath());
        const ssh = new Ssh2SSHClient();
        // Only ever true for a real apply run at a real terminal -- a dry
        // run never execs anything, and the web UI's job runner has no
        // terminal to attach to in the first place (see issue #56).
        const interactive = Boolean(process.stdin.isTTY) && Boolean(opts.apply);
        const { script, applied } = await runInstallApp({ ...opts, interactive }, { ssh, inventory });
        if (!applied) {
          logInfo(`[DRY RUN] Would run on ${opts.host}:`);
          console.log(script);
        }
      }
    )
  );

program
  .command('deploy-vpn-gateway')
  .description('Create a new VPN gateway LXC (NordVPN/PIA) and start its management agent')
  .requiredOption('--host <pve-host>')
  .requiredOption('--mid <n>', 'machine ID 1-254', (v) => parsePositiveInt(v, '--mid'))
  .requiredOption('--name <guest-name>')
  .requiredOption('--vpn <nordvpn|pia>')
  .option('--apply')
  .action(
    action(async (opts: { host: string; mid: number; name: string; vpn: 'nordvpn' | 'pia'; apply?: boolean }) => {
      const invPath = inventoryPath();
      const inventory = loadInventory(invPath);
      const ssh = new Ssh2SSHClient();
      const result = await runDeployVpnGateway(
        { host: opts.host, mid: opts.mid, name: opts.name, vpn: opts.vpn, apply: opts.apply },
        { ssh, inventory, inventoryPath: invPath }
      );
      if (!result.applied) {
        logInfo(`[DRY RUN] Would run on ${opts.host}:`);
        console.log(result.createCommand);
      }
    })
  );

program
  .command('set-guest-vpn')
  .description("Point a guest's default route at a VPN gateway (or back at the LAN router) and configure split-DNS")
  .requiredOption('--guest <name>')
  .requiredOption('--vpn <gateway-name|none>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; vpn: string | 'none'; apply?: boolean }) => {
      const invPath = inventoryPath();
      const inventory = loadInventory(invPath);
      const ssh = new Ssh2SSHClient();
      const result = await runSetGuestVpn(opts, { ssh, inventory, inventoryPath: invPath });
      if (!result.applied) {
        logInfo(`[DRY RUN] Would run on ${opts.guest}'s parent host:`);
        console.log(result.netScript);
        logInfo(`[DRY RUN] Would then run on ${opts.guest} (installs dnsmasq / restores resolv.conf) and RESTART it -- brief outage:`);
        console.log(result.dnsScript);
      }
    })
  );

program
  .command('migrate-nfs-mount')
  .description("Convert a guest's direct NFS mount into a host-relay bind-mount")
  .requiredOption('--guest <name>')
  .requiredOption('--storage <storage-id>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; storage: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      const result = await runMigrateNfsMount(
        { ...opts, fstabPath: fstabPath(), nfsServer: nfsServer() },
        { ssh, inventory }
      );
      if (!result.applied) {
        logInfo(`[DRY RUN] Would run on ${opts.guest} (tears down the direct NFS mount):`);
        console.log(result.guestScript);
        logInfo(
          `[DRY RUN] Would then run on ${opts.guest}'s parent host (adds the bind-mount and RESTARTS ${opts.guest} -- brief outage):`
        );
        console.log(result.hostScript);
      }
    })
  );

program
  .command('delete-guest')
  .description('Stop, optionally back up (vzdump), and destroy an lxc/vm guest on its parent host, then update inventory')
  .requiredOption('--guest <name>')
  .option('--backup', 'take a vzdump backup before destroying (requires --backup-storage)')
  .option('--backup-storage <storage-id>')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; backup?: boolean; backupStorage?: string; apply?: boolean }) => {
      const inventory = loadInventory(inventoryPath());
      const ssh = new Ssh2SSHClient();
      await runDeleteGuest(opts, { ssh, inventory, inventoryPath: inventoryPath() });
    })
  );

program
  .command('migrate-guest')
  .description(
    "Move an existing lxc/vm guest to another Proxmox host, renumbering its VMID/IP to match the target host's convention"
  )
  .requiredOption('--guest <name>')
  .requiredOption('--to-host <host>')
  .option('--mid <n>', 'machine ID 1-254 on the target host (default: same numeric suffix as the current vmid)', (v) =>
    parsePositiveInt(v, '--mid')
  )
  .option('--backup-storage <storage-id>', 'cluster-shared backup storage to stage the migration through (default: the configured backupStorage)')
  .option('--storage <storage-id>', 'target guest storage on the destination host (default: automatic)')
  .option('--apply')
  .action(
    action(async (opts: { guest: string; toHost: string; mid?: number; backupStorage?: string; storage?: string; apply?: boolean }) => {
      const invPath = inventoryPath();
      const inventory = loadInventory(invPath);
      const ssh = new Ssh2SSHClient();
      await runMigrateGuest(opts, { ssh, inventory, inventoryPath: invPath });
    })
  );

program.parseAsync(process.argv);
