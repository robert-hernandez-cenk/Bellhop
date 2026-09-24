import type { SSHClient, ExecResult } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, resolveMid, stripCidr, checkVmidAvailable, hostSshTarget, type ResolvedMid } from '../../lib/targets.ts';
import { shellQuote, InteractiveCancelledError } from '../../lib/ssh-client.ts';
import { logInfo, logWarn } from '../../lib/log.ts';
import { pickStorage } from '../../lib/storage.ts';
import { resolveNfsMountPath, buildNfsAttachScript } from '../../lib/nfs.ts';
import { readHostAuthorizedKeys } from '../../lib/authorized-keys.ts';
import { UPSTREAM_STABLE_BASE, UPSTREAM_DEV_BASE } from '../../lib/app-source.ts';
export { pickStorage } from '../../lib/storage.ts';

// The /ct-scoped bases resolveAppUrl/resolveDevAppUrl build URLs from,
// derived from app-source.ts's raw repo-root constants (shared with that
// module's own custom-repository resolution) rather than hardcoded here a
// second time.
const COMMUNITY_SCRIPTS_BASE = `${UPSTREAM_STABLE_BASE}/ct`;
// Apps still under active development (e.g. budget-board) live in a
// separate repo -- same owner, same ct/<slug>.sh layout, "ProxmoxVED"
// (dev) instead of "ProxmoxVE" -- until they graduate to the main one.
// Never assumed up front: resolveAppUrl always targets the main repo, and
// this is only ever tried as a fallback once that 404s (see
// buildInstallAppScript's curl fallback and provisioning.ts's checkAppUrl).
const COMMUNITY_SCRIPTS_DEV_BASE = `${UPSTREAM_DEV_BASE}/ct`;

// --app accepts either a bare community-scripts slug ("plex") or a full script
// URL pasted verbatim -- the latter is used as-is, with no reformatting, so
// any installer script reachable over plain curl works, not just the
// community-scripts catalog. A bare slug is lowercased first since every
// script in that repo is lowercase and GitHub raw URLs are case-sensitive --
// without this, typing "Plex" would 404 and look like an invalid app even
// though the install would otherwise have worked.
export function resolveAppUrl(app: string): string {
  return app.includes('://') ? app : `${COMMUNITY_SCRIPTS_BASE}/${app.toLowerCase()}.sh`;
}

// The dev-repo counterpart of resolveAppUrl's URL -- undefined for a pasted
// full URL, which has no dev-repo equivalent to fall back to.
export function resolveDevAppUrl(app: string): string | undefined {
  return app.includes('://') ? undefined : `${COMMUNITY_SCRIPTS_DEV_BASE}/${app.toLowerCase()}.sh`;
}

// The install/<slug>-install.sh counterpart of a ct/<slug>.sh URL. That file
// is the one build.func downloads and runs *inside* the new container, and it
// is where an app's own interactive `read` prompts actually live -- the ct
// script's prompts, where it has any, sit in update_script(), which
// install-app never reaches. Issue #160.
//
// Derived from an already-resolved ct URL rather than from the raw --app
// value, so it automatically follows whichever repo (ProxmoxVE or ProxmoxVED)
// the ct script was actually found in. Returns undefined for a pasted full
// URL that isn't shaped like a community-scripts ct path -- there is no
// counterpart to derive, and guessing one would 404 on every request.
export function resolveInstallScriptUrl(ctUrl: string): string | undefined {
  const match = ctUrl.match(/^(.*)\/ct\/([^/]+)\.sh$/);
  if (!match) return undefined;
  const [, base, slug] = match;
  return `${base}/install/${slug}-install.sh`;
}

// The community-scripts slug to record on a newly-installed guest's
// inventory entry -- mirrors resolveAppUrl's exact bare-slug-vs-pasted-URL
// split and lowercasing, since a pasted full script URL has no
// community-scripts page to link to.
export function appSlugFor(app: string): string | undefined {
  return app.includes('://') ? undefined : app.toLowerCase();
}

export interface InstallAppOptions {
  host: string;
  mid: number;
  app: string;
  hostname: string;
  cores?: number;
  memory?: number;
  disk?: number;
  bridge?: string;
  // Operator-chosen storage (the web UI's Template/Container Storage
  // dropdowns); falls back to pickStorage's automatic selection when
  // omitted, so the CLI (which has no such flags) keeps working unchanged.
  templateStorage?: string;
  containerStorage?: string;
  // Both required together (validated at the top of runInstallApp) or both
  // omitted -- an optional host-relay bind-mount attached right after the
  // guest is created, reusing attach-nfs-mount's own resolution/script
  // logic via src/lib/nfs.ts.
  nfsStorage?: string;
  nfsMountPoint?: string;
  apply?: boolean;
  // Set by cli.ts's install-app action when attached to a real terminal
  // (process.stdin.isTTY) -- routes the install-script exec through
  // execInteractive() instead of the buffered runRemote path, so any
  // app-specific prompt the community-scripts installer shows is visible
  // and answerable live. Never set by the web UI, which has no terminal
  // to attach to.
  interactive?: boolean;
}

export function buildInstallAppScript(
  opts: InstallAppOptions,
  mid: ResolvedMid,
  storage: { template: string; container: string },
  hostKeys?: string
): string {
  const cores = opts.cores ?? 1;
  const memory = opts.memory ?? 512;
  const disk = opts.disk ?? 8;
  const bridge = opts.bridge ?? 'vmbr0';
  const appUrl = resolveAppUrl(opts.app);
  const devAppUrl = resolveDevAppUrl(opts.app);
  // Tried at curl-time rather than resolved up front: curl -fsSL exits
  // non-zero and prints nothing on a 404 (-f), so `curl1 || curl2` inside
  // $(...) reliably falls back to the dev-repo script only when the main
  // repo's actually 404s, with no separate existence check needed here.
  const curlAppScript = devAppUrl
    ? `curl -fsSL ${shellQuote(appUrl)} 2>/dev/null || curl -fsSL ${shellQuote(devAppUrl)}`
    : `curl -fsSL ${shellQuote(appUrl)}`;
  return [
    // community-scripts' shared build.func calls `clear` unconditionally
    // partway through, even in unattended mode (the var_* overrides below
    // only bypass the whiptail dialogs, not that call) -- with no pty/TERM
    // over pct exec's non-interactive bash, `clear` fails outright
    // ("TERM environment variable not set"), aborting the whole install.
    // xterm is present in the base terminfo database on every Debian/Ubuntu
    // template this toolkit uses.
    'export TERM=xterm',
    // build.func's install_script() shows an interactive "Default Install /
    // Advanced Install / ..." whiptail menu whenever $mode is unset
    // (`CHOICE="${mode:-${1:-}}"`, and the script is invoked with no
    // positional args) -- it does NOT check for a real tty first, so over a
    // non-interactive pct exec session it renders the menu and then hangs
    // forever waiting for a keypress that can never arrive. mode=default
    // selects the same "Default Install" choice the var_* overrides already
    // assume. PHS_SILENT=1 is build.func's own documented headless-mode
    // flag, covering the other interactive prompts it guards (OS-mismatch
    // checks, addon-update prompts, ...) with their own safe default
    // (usually "abort" rather than silently proceeding).
    'export mode=default',
    'export PHS_SILENT=1',
    `export var_hostname=${shellQuote(opts.hostname)}`,
    `export var_ctid=${mid.vmid}`,
    `export var_cpu=${cores}`,
    `export var_ram=${memory}`,
    `export var_disk=${disk}`,
    `export var_brg=${shellQuote(bridge)}`,
    `export var_net=${shellQuote(mid.ip)}`,
    `export var_gateway=${shellQuote(mid.gateway)}`,
    `export var_template_storage=${shellQuote(storage.template)}`,
    `export var_container_storage=${shellQuote(storage.container)}`,
    // community-scripts' own install_ssh_keys_into_ct() (misc/build.func)
    // is gated by var_ssh/var_ssh_authorized_key, read as plain env vars
    // that take precedence over its default.vars file -- setting them
    // here pre-answers the interactive "add an SSH key?" prompt its own
    // Advanced Settings flow would otherwise show, with the same keys
    // already trusted on this host today (see src/lib/authorized-keys.ts).
    `export var_ssh=${hostKeys ? 'yes' : 'no'}`,
    ...(hostKeys ? [`export var_ssh_authorized_key=${shellQuote(hostKeys)}`] : []),
    // build.func reads var_template_storage/var_container_storage out of
    // /usr/local/community-scripts/default.vars (ensure_storage_selection_
    // for_vars_file()), not from these env vars directly -- if that file is
    // missing either key, it shows an interactive storage-pool whiptail
    // picker with no real tty to answer it, hanging forever (discovered
    // live: install-app hung on pve-node-a asking to choose between
    // `local` and `nas-proxmox` for the container template). Upserting both
    // keys -- rather than gating on the file merely *existing* -- matters
    // because build.func's own ensure_global_default_vars_file() touches an
    // *empty* default.vars into existence as a side effect of even a hung
    // attempt, before it ever reaches storage selection; a plain
    // `[ -f default.vars ] || write` would see that leftover empty file and
    // skip writing our values into it, hanging again on retry. sed -i
    // removing any prior line for each key before appending (the same
    // pattern build.func's own _write_storage_to_vars uses) converges to
    // our chosen values no matter what state the file was already in.
    'mkdir -p /usr/local/community-scripts',
    'touch /usr/local/community-scripts/default.vars',
    "sed -i '/^[#[:space:]]*var_template_storage=/d;/^[#[:space:]]*var_container_storage=/d' /usr/local/community-scripts/default.vars",
    `printf 'var_template_storage=%s\\nvar_container_storage=%s\\n' ${shellQuote(storage.template)} ${shellQuote(storage.container)} >> /usr/local/community-scripts/default.vars`,
    `bash -c "$(${curlAppScript})"`,
  ].join('\n');
}

export async function runInstallApp(
  opts: InstallAppOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ script: string; mid: ResolvedMid; applied: boolean }> {
  if (!opts.app.includes('://') && !/^[a-z0-9-]+$/.test(opts.app)) {
    throw new Error(`--app must contain only lowercase letters, digits, and hyphens, got: ${opts.app}`);
  }
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
  await checkVmidAvailable(deps.ssh, deps.inventory, opts.host, mid.vmid);
  const storage = {
    template: opts.templateStorage || pickStorage(host, ['vztmpl']),
    container: opts.containerStorage || pickStorage(host, ['rootdir', 'images']),
  };
  // Resolved in both dry-run and apply, mirroring resolveNfsMountPath
  // below -- so the previewed script is provably identical to what apply
  // sends (this is the same script build.func runs, so the env vars must
  // be baked in at build time, not appended as a separate call the way
  // create-lxc's own follow-up pct exec is).
  const hostKeys = await readHostAuthorizedKeys(deps.ssh, deps.inventory, opts.host);
  const installScript = buildInstallAppScript(opts, mid, storage, hostKeys);

  let nfsScript: string | undefined;
  if (opts.nfsStorage && opts.nfsMountPoint) {
    const storagePath = await resolveNfsMountPath(deps.ssh, deps.inventory, host, opts.nfsStorage);
    // A freshly created guest has no existing bind-mounts, so mp0 is
    // always free -- unlike attach-nfs-mount, which scans pct config for
    // the next free index on a guest that may already have some.
    nfsScript = buildNfsAttachScript(mid.vmid, 0, storagePath, opts.nfsMountPoint);
  }
  const script = nfsScript ? `${installScript}\n\n# --- attach NFS mount (separate remote call) ---\n${nfsScript}` : installScript;

  if (!opts.apply) {
    return { script, mid, applied: false };
  }
  if (!hostKeys) {
    logWarn(`No authorized_keys found on host '${opts.host}'; skipping SSH key provisioning for ${opts.hostname}`);
  }
  logInfo(`Running on ${opts.host}: install ${opts.app} (ctid=${mid.vmid} hostname=${opts.hostname})`);
  let result: ExecResult;
  if (opts.interactive) {
    try {
      result = await deps.ssh.execInteractive(hostSshTarget(host), installScript);
    } catch (err) {
      if (err instanceof InteractiveCancelledError) {
        throw new Error(
          `Install cancelled -- vmid ${mid.vmid} on ${opts.host} may be left partially created; run "pct status ${mid.vmid}" on ${opts.host} and clean up manually before retrying with the same --mid.`,
          { cause: err }
        );
      }
      throw err;
    }
  } else {
    result = await runRemote(deps.ssh, deps.inventory, opts.host, installScript);
  }
  if (result.code !== 0) {
    const detail = opts.interactive ? 'see the output above' : result.stderr || result.stdout;
    throw new Error(`install-app script failed on ${opts.host} (exit ${result.code}): ${detail}`);
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
  return { script, mid, applied: true };
}
