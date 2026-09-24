import type { GuestEntry } from '../lib/inventory.ts';
import { saveInventory, refreshInventory, parseSubdomains, parsePort } from '../lib/inventory.ts';
import { probeInsecureBackendTls } from '../lib/tls-probe.ts';
import { stripCidr } from '../lib/targets.ts';
import { withCapturedConsole } from '../web/console-capture.ts';
import { syncCaddyLive } from '../web/caddy-sync.ts';
import { runCreateLxc } from '../commands/provisioning/create-lxc.ts';
import { runCreateVm } from '../commands/provisioning/create-vm.ts';
import { runInstallApp, appSlugFor } from '../commands/provisioning/install-app.ts';
import { runConfigureGuest } from '../commands/provisioning/configure-guest.ts';
import { runAttachNfsMount } from '../commands/provisioning/attach-nfs-mount.ts';
import { runMigrateNfsMount } from '../commands/provisioning/migrate-nfs-mount.ts';
import { runDeleteGuest } from '../commands/provisioning/delete-guest.ts';
import { runDeployVpnGateway } from '../commands/provisioning/deploy-vpn-gateway.ts';
import { runMigrateGuest } from '../commands/provisioning/migrate-guest.ts';
import { runSyncAuthentik, conflictExplanation } from '../commands/networking/sync-authentik.ts';
import { logWarn } from '../lib/log.ts';
import type { Operation, OperationDeps } from './types.ts';
import { reqStr, optStr, reqInt, optInt, flag, portStr } from './fields.ts';

function upsertGuestEntry(guests: GuestEntry[], entry: GuestEntry): GuestEntry[] {
  const idx = guests.findIndex((g) => g.host === entry.host && g.vmid === entry.vmid);
  if (idx === -1) return [...guests, entry];
  const existing = guests[idx];
  const subdomains =
    entry.subdomains && entry.subdomains.length > 0
      ? Array.from(new Set([...(existing.subdomains ?? []), ...entry.subdomains]))
      : existing.subdomains;
  // entry.port is undefined whenever the create/install form's Port field was
  // left blank -- fall back to whatever port the existing entry already had
  // (e.g. one set by hand or by a prior Dashboard edit) instead of the plain
  // `{ ...existing, ...entry }` spread silently overwriting it with undefined.
  const port = entry.port !== undefined ? entry.port : existing.port;
  // entry.app is undefined whenever install-app's apply built it from
  // appSlugFor(b.app) and the operator pasted a full script URL instead of a
  // bare community-scripts slug -- fall back to the existing recorded slug so
  // a repeat apply for the same host+vmid doesn't silently clobber a
  // previously-good app slug with undefined.
  const app = entry.app !== undefined ? entry.app : existing.app;
  // Same reasoning as port/app: entry.insecureBackendTls is undefined
  // whenever the create/install form's checkbox was left unchecked (or its
  // key omitted entirely, since an untouched checkbox never enters the
  // generic form's values object) -- fall back to whatever the existing
  // entry already had rather than silently clearing it on a repeat apply.
  const insecureBackendTls = entry.insecureBackendTls !== undefined ? entry.insecureBackendTls : existing.insecureBackendTls;
  const merged: GuestEntry = { ...existing, ...entry, subdomains, port, app, insecureBackendTls };
  return guests.map((g, i) => (i === idx ? merged : g));
}

// ~3 minutes worst case (first attempt immediate, then 6 more 30s apart) --
// long enough to ride out a freshly-created guest's app still starting up
// and binding its port, without making every create job with subdomains
// feel indefinitely stuck.
const CREATE_PROBE_RETRIES = 6;
const CREATE_PROBE_INTERVAL_MS = 30_000;

// Writes the just-created guest into bellhop.db right away, instead of
// requiring a separate Sync Inventory run afterward -- and updates the
// shared in-memory `inventory` object too (saveInventory only touches disk),
// so the next request (another create form's MID/bridge suggestions, a
// GET /api/inventory) sees it without a server restart. If the guest was
// given subdomains, also pushes them live (Caddyfile + status page) via
// syncCaddyLive in the same step -- a failure here (e.g. no 'caddy: true'
// entry, Caddy validation) fails the whole apply job, since "create this
// guest with subdomains X" only fully succeeds once X is actually routable.
async function recordProvisionedGuest(deps: OperationDeps, entry: GuestEntry): Promise<void> {
  // Only when there's a concrete ip+port+subdomains combo to test -- same
  // "don't guess which port" principle the rest of this feature follows.
  // A conclusive result always overwrites whatever the create/install
  // form's checkbox submitted; an inconclusive one (app not listening yet,
  // even after retrying) leaves it exactly as submitted.
  if (entry.port !== undefined && entry.ip && entry.subdomains && entry.subdomains.length > 0 && !entry.caddyManual) {
    const probe = await probeInsecureBackendTls(deps.ssh, deps.inventory, entry.host, entry.ip, entry.port, {
      retries: CREATE_PROBE_RETRIES,
      intervalMs: CREATE_PROBE_INTERVAL_MS,
      sleepFn: deps.tlsProbeSleepFn,
    });
    if (probe !== 'inconclusive') {
      entry = { ...entry, insecureBackendTls: probe === 'insecure' };
    }
  }

  // #16: the create/install (and the TLS probe's retries) can take minutes
  // after the job started, so reload right before the read-modify-write --
  // otherwise saveInventory rewrites everything from a stale snapshot and
  // drops edits (including cleared/added settings) made in the meantime.
  refreshInventory(deps.inventory, deps.inventoryPath);
  const guests = upsertGuestEntry(deps.inventory.guests, entry);
  saveInventory(deps.inventoryPath, { ...deps.inventory, guests });
  deps.inventory.guests = guests;

  if (entry.subdomains && entry.subdomains.length > 0) {
    await syncCaddyLive(deps);
  }
}

const sizing = {
  cores: optInt('Cores'),
  memory: optInt('Memory (MB)'),
  disk: optInt('Disk (GB)'),
  bridge: optStr('Network bridge (defaults to vmbr0)'),
};

const subdomainsField = optStr('Subdomains, ;-separated');
const nfsFields = {
  nfsStorage: optStr('Existing Proxmox nfs: storage to bind-mount (optional; requires nfsMountPoint)'),
  nfsMountPoint: optStr('Absolute mount point inside the guest (optional; requires nfsStorage)'),
};

export const PROVISIONING_OPERATIONS: Record<string, Operation> = {
  'create-lxc': {
    id: 'create-lxc',
    category: 'provisioning',
    description: 'Create a new LXC container on a Proxmox host.',
    shape: {
      host: reqStr('Proxmox host name'),
      mid: reqInt('Machine ID (2-252): derives VMID and IP from the host midScheme'),
      hostname: reqStr('Container hostname'),
      template: reqStr('Container template'),
      ...sizing,
      storage: optStr('Rootfs storage (defaults to automatic selection)'),
      subdomains: subdomainsField,
      insecureBackendTls: flag('Backend serves untrusted/self-signed TLS'),
      ...nfsFields,
    },
    target: (i) => i.host,
    targetType: 'host',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runCreateLxc({ ...(i as any), apply: false }, deps));
      return [text, result.command].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runCreateLxc({ ...(i as any), apply: true }, deps);
      await recordProvisionedGuest(deps, {
        name: i.hostname,
        type: 'lxc',
        vmid: result.mid.vmid,
        host: i.host,
        ip: stripCidr(result.mid.ip),
        subdomains: parseSubdomains(i.subdomains),
        insecureBackendTls: i.insecureBackendTls === true ? true : undefined,
      });
    },
  },
  'create-vm': {
    id: 'create-vm',
    category: 'provisioning',
    description: 'Create a new VM on a Proxmox host.',
    shape: {
      host: reqStr('Proxmox host name'),
      mid: reqInt('Machine ID (2-252): derives VMID and IP from the host midScheme'),
      name: reqStr('VM name'),
      ...sizing,
      diskStorage: optStr('Disk storage (defaults to automatic selection)'),
      cloudInit: flag('Attach a cloud-init drive'),
      subdomains: subdomainsField,
      insecureBackendTls: flag('Backend serves untrusted/self-signed TLS'),
    },
    target: (i) => i.host,
    targetType: 'host',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runCreateVm({ ...(i as any), apply: false }, deps));
      return [text, result.command].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runCreateVm({ ...(i as any), apply: true }, deps);
      await recordProvisionedGuest(deps, {
        name: i.name,
        type: 'vm',
        vmid: result.mid.vmid,
        host: i.host,
        ip: stripCidr(result.mid.ip),
        subdomains: parseSubdomains(i.subdomains),
        insecureBackendTls: i.insecureBackendTls === true ? true : undefined,
      });
    },
  },
  'install-app': {
    id: 'install-app',
    category: 'provisioning',
    description:
      'Create a new LXC container by running a community-scripts (ProxmoxVE) install script unattended. The job watches for interactive prompts; answer them with answer_job_prompt.',
    shape: {
      app: reqStr('community-scripts app slug or full script URL'),
      host: reqStr('Proxmox host name'),
      mid: reqInt('Machine ID (2-252): derives VMID and IP from the host midScheme'),
      hostname: reqStr('Container hostname'),
      ...sizing,
      templateStorage: optStr('Template storage (defaults to automatic selection)'),
      containerStorage: optStr('Container storage (defaults to automatic selection)'),
      port: portStr('Port the installed app listens on'),
      subdomains: subdomainsField,
      insecureBackendTls: flag('Backend serves untrusted/self-signed TLS (normally determined by a live probe)'),
      ...nfsFields,
    },
    target: (i) => i.host,
    targetType: 'host',
    watchForPrompts: true,
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runInstallApp({ ...(i as any), apply: false }, deps));
      return [text, result.script].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runInstallApp({ ...(i as any), apply: true }, deps);
      await recordProvisionedGuest(deps, {
        name: i.hostname,
        type: 'lxc',
        vmid: result.mid.vmid,
        host: i.host,
        ip: stripCidr(result.mid.ip),
        subdomains: parseSubdomains(i.subdomains),
        port: i.port ? parsePort(i.port) : undefined,
        app: appSlugFor(i.app),
        insecureBackendTls: i.insecureBackendTls === true ? true : undefined,
      });
    },
  },
  'deploy-vpn-gateway': {
    id: 'deploy-vpn-gateway',
    category: 'provisioning',
    description: 'Create a new VPN gateway LXC (NordVPN or PIA) that other guests can route through.',
    shape: {
      vpn: reqStr('VPN provider: nordvpn or pia'),
      host: reqStr('Proxmox host name'),
      mid: reqInt('Machine ID (2-252): derives VMID and IP from the host midScheme'),
      name: reqStr('Gateway guest name'),
      accessToken: optStr('NordVPN access token (nordvpn only)'),
      piaUsername: optStr('PIA username (pia only)'),
      piaPassword: optStr('PIA password (pia only)'),
      storage: optStr('Rootfs storage (defaults to automatic selection)'),
      // Internal test-speed knobs for the post-provision connectivity poll
      // (see DeployVpnGatewayOptions in deploy-vpn-gateway.ts) -- never
      // exposed as a web form field (absent from PROVISIONING_COMMANDS'
      // deploy-vpn-gateway fields) and hidden from the MCP tool's input
      // schema via internalFields below; kept in this shape only so a
      // caller that does supply them (the test suite) still reaches
      // runDeployVpnGateway with them, instead of parseOperationInput
      // silently stripping them back to the real ~60s defaults.
      connectPollAttempts: optInt('Internal test-speed knob: connectivity poll retry count'),
      connectPollDelayMs: optInt('Internal test-speed knob: connectivity poll delay in ms'),
    },
    target: (i) => i.host,
    targetType: 'host',
    secretFields: ['accessToken', 'piaPassword'],
    internalFields: ['connectPollAttempts', 'connectPollDelayMs'],
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() =>
        runDeployVpnGateway({ ...(i as any), apply: false }, deps)
      );
      return [text, result.createCommand].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      await runDeployVpnGateway({ ...(i as any), apply: true }, deps);
    },
  },
  'configure-guest': {
    id: 'configure-guest',
    category: 'provisioning',
    description: 'Install packages and/or add an SSH public key on an existing guest.',
    shape: {
      guest: reqStr('Guest or host name'),
      packages: optStr('Packages to install, space-separated'),
      sshKey: optStr('SSH public key to add'),
    },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text } = await withCapturedConsole(() => runConfigureGuest({ ...(i as any), apply: false }, deps));
      return text;
    },
    apply: async (i, deps) => {
      await runConfigureGuest({ ...(i as any), apply: true }, deps);
    },
  },
  'attach-nfs-mount': {
    id: 'attach-nfs-mount',
    category: 'provisioning',
    description:
      'Attach an lxc guest to an existing NFS storage entry via a host-relay bind-mount. Restarts the guest (brief outage).',
    shape: {
      guest: reqStr('lxc guest name'),
      storage: reqStr('Existing Proxmox nfs: storage name'),
      mountPoint: reqStr('Absolute mount point inside the guest'),
    },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runAttachNfsMount({ ...(i as any), apply: false }, deps));
      return [text, result.hostScript].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      await runAttachNfsMount({ ...(i as any), apply: true }, deps);
    },
  },
  // Still reachable from its web route; not exposed over MCP (see
  // src/operations/index.ts) since every guest has already been migrated.
  'migrate-nfs-mount': {
    id: 'migrate-nfs-mount',
    category: 'provisioning',
    description: 'Convert a guest from a direct NFS mount to a host-relay bind-mount.',
    shape: {
      guest: reqStr('Guest name'),
      storage: reqStr('Existing Proxmox nfs: storage name'),
    },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runMigrateNfsMount({ ...(i as any), apply: false }, deps));
      return [text, result.guestScript, result.hostScript].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      await runMigrateNfsMount({ ...(i as any), apply: true }, deps);
    },
  },
  'delete-guest': {
    id: 'delete-guest',
    category: 'provisioning',
    description: 'Destroy an lxc/vm guest, optionally backing it up first, and remove it from inventory, Caddy, and Authentik.',
    shape: {
      guest: reqStr('Guest name'),
      backup: flag('Back up the guest before destroying it'),
      backupStorage: optStr('Backup storage (required when backup is true)'),
    },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text } = await withCapturedConsole(() => runDeleteGuest({ ...(i as any), apply: false }, deps));
      return text;
    },
    apply: async (i, deps) => {
      const target = deps.inventory.guests.find((g) => g.name === i.guest);
      if (target?.caddy === true) {
        throw new Error(
          `Refusing to delete '${i.guest}' -- it's flagged 'caddy: true' (this is the guest hosting Caddy itself)`
        );
      }

      // Authentik teardown must run BEFORE runDeleteGuest removes the guest
      // from inventory -- sync-authentik's candidateEntries only recognizes
      // a removal target while some current entry still owns the subdomain,
      // so this must run against a snapshot where the guest is still
      // present but no longer desired, or its Provider/Application/policy-
      // binding would be orphaned forever.
      // Skipped rather than attempted when there is no Authentik API to talk
      // to -- same guard as syncCaddyLive (src/web/caddy-sync.ts), and for
      // the same reason: runSyncAuthentik calls listApplications() before
      // checking whether anything actually needs gating, so an operator
      // running forward-auth without an admin token could not delete a
      // gated guest at all without this check.
      if (deps.authentik.isConfigured() && target?.authGroup && target.subdomains && target.subdomains.length > 0) {
        const preRemovalInventory = {
          ...deps.inventory,
          guests: deps.inventory.guests.map((g) => (g.name === i.guest ? { ...g, authGroup: undefined } : g)),
        };
        const result = await runSyncAuthentik({ apply: true }, { authentik: deps.authentik, inventory: preRemovalInventory });
        for (const name of result.conflicts) logWarn(`sync-authentik: ${name} — ${conflictExplanation(name, result)}`);
      }

      await runDeleteGuest({ ...(i as any), apply: true }, deps);

      // runDeleteGuest already removed the guest and saved inventory --
      // deps.inventory.guests reflects that now, so a stale Caddy site
      // block for it (if it had subdomains) just needs a resync to
      // disappear, same as sync-caddy's buildCaddyBlock always did.
      if (target?.subdomains && target.subdomains.length > 0) {
        await syncCaddyLive(deps);
      }
    },
  },
  'migrate-guest': {
    id: 'migrate-guest',
    category: 'provisioning',
    description:
      "Move an existing lxc/vm guest to another Proxmox host, renumbering its VMID/IP to match the target host's convention. Destroys the original once the new guest is verified running -- cannot be undone.",
    shape: {
      guest: reqStr('Guest name'),
      toHost: reqStr('Target Proxmox host name'),
      mid: optInt("Machine ID (2-252); defaults to the current vmid's numeric suffix"),
      backupStorage: optStr('Backup storage (defaults to the configured backupStorage)'),
      storage: optStr('Target storage (defaults to automatic selection)'),
    },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runMigrateGuest({ ...(i as any), apply: false }, deps));
      return [text, result.sourceScript, result.targetScript].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      await runMigrateGuest({ ...(i as any), apply: true }, deps);
    },
  },
};
