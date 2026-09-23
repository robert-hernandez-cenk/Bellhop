import type { SSHClient, ExecResult } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { resolveAppUrl, resolveDevAppUrl } from '../provisioning/install-app.ts';

export interface UpdateAppOptions {
  guest: string;
  app: string;
  apply?: boolean;
}

export function buildUpdateAppScript(app: string): string {
  const appUrl = resolveAppUrl(app);
  const devAppUrl = resolveDevAppUrl(app);
  // An app installed while still "in development" (see install-app.ts's
  // matching comment on COMMUNITY_SCRIPTS_DEV_BASE, e.g. budget-board) came
  // from the dev repo -- re-running its ct/<app>.sh for an update needs the
  // same curl fallback install-app's generated script uses, or it 404s
  // against the main repo every time.
  const curlAppScript = devAppUrl
    ? `curl -fsSL ${shellQuote(appUrl)} 2>/dev/null || curl -fsSL ${shellQuote(devAppUrl)}`
    : `curl -fsSL ${shellQuote(appUrl)}`;
  return [
    // see the matching comments in install-app.ts's buildInstallAppScript --
    // community-scripts' build.func calls `clear` even in unattended mode,
    // and (running here, inside the guest rather than on the pve host)
    // start() takes its "show update/setting menu" branch and hangs the
    // same way install_script()'s menu does unless PHS_SILENT=1 selects the
    // "silent mode: runs update_script with automatic cleanup" branch
    // instead.
    'export TERM=xterm',
    'export PHS_SILENT=1',
    'DEBIAN_FRONTEND=noninteractive apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y curl',
    `bash -c "$(${curlAppScript})"`,
  ].join('\n');
}

export async function runUpdateApp(
  opts: UpdateAppOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ script: string; ran: boolean; result?: ExecResult }> {
  if (!/^[a-z0-9-]+$/.test(opts.app)) {
    throw new Error(`--app must contain only lowercase letters, digits, and hyphens, got: ${opts.app}`);
  }
  const entryExists =
    deps.inventory.hosts.some((h) => h.name === opts.guest) || deps.inventory.guests.some((g) => g.name === opts.guest);
  if (!entryExists) {
    throw new Error(`Unknown inventory entry: ${opts.guest}`);
  }

  const script = buildUpdateAppScript(opts.app);
  if (!opts.apply) {
    return { script, ran: false };
  }
  const result = await runRemote(deps.ssh, deps.inventory, opts.guest, script);
  return { script, ran: true, result };
}
