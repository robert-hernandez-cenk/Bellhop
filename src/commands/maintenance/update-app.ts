import type { SSHClient, ExecResult } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { resolveAppUrl, resolveDevAppUrl } from '../provisioning/install-app.ts';
import { resolveAppSource, formatOverrideWarning, type AppSource } from '../../lib/app-source.ts';
import { logWarn } from '../../lib/log.ts';

export interface UpdateAppOptions {
  guest: string;
  app: string;
  apply?: boolean;
  // A pre-resolved source (research R5, mirroring InstallAppOptions.source):
  // previewAndEnqueue resolves once per operation and passes its result here
  // so preview and apply both read the same pinned commit instead of each
  // separately calling resolveAppSource. When omitted (the CLI, and the
  // plain web/MCP preview routes that call op.preview directly), runUpdateApp
  // resolves it itself.
  source?: AppSource;
  // Only consulted when `source` is omitted, to resolve one. Defaults to the
  // global fetch.
  fetchImpl?: typeof fetch;
}

export function buildUpdateAppScript(app: string, source?: AppSource): string {
  const appUrl = resolveAppUrl(app);
  const devAppUrl = resolveDevAppUrl(app);
  const isCustom = source?.kind === 'custom';
  // Mirrors buildInstallAppScript's own isCustom split (install-app.ts): a
  // custom-repository resolution has already confirmed the script exists at
  // the pinned commit (resolveAppSource's own ct/<slug>.sh fetch), so it
  // curls that one URL directly, with no upstream fallback.
  const curlAppScript = isCustom
    ? `curl -fsSL ${shellQuote(source!.ctUrl!)}`
    : devAppUrl
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
    // research R1: exported at the pinned commit, never the branch name, and
    // only for a custom-repository resolution -- see buildInstallAppScript's
    // matching comment for why this must be set before the update-triggering
    // curl runs (community-scripts' shared core/build.func resolves every
    // non-engine path against it when it's set).
    ...(isCustom ? [`export COMMUNITY_SCRIPTS_URL=${shellQuote(source!.scriptsBaseUrl!)}`] : []),
    `bash -c "$(${curlAppScript})"`,
  ].join('\n');
}

export async function runUpdateApp(
  opts: UpdateAppOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ script: string; ran: boolean; result?: ExecResult; source: AppSource }> {
  if (!/^[a-z0-9-]+$/.test(opts.app)) {
    throw new Error(`--app must contain only lowercase letters, digits, and hyphens, got: ${opts.app}`);
  }
  const entryExists =
    deps.inventory.hosts.some((h) => h.name === opts.guest) || deps.inventory.guests.some((g) => g.name === opts.guest);
  if (!entryExists) {
    throw new Error(`Unknown inventory entry: ${opts.guest}`);
  }

  // research R1/R5: resolved (or reused, when the caller already pinned one
  // -- see UpdateAppOptions.source) after the argument checks above but
  // before any exec, mirroring runInstallApp's own ordering -- a resolution
  // failure (bad customScriptsRepo/Branch, GitHub unreachable) must never
  // reach the guest. The override warning, when the resolved source also
  // shadows an upstream copy of the same slug, is logged here so it's the
  // first line of a dry run, a captured preview, and the apply job's log.
  const source = opts.source ?? (await resolveAppSource(opts.app, deps.inventory, opts.fetchImpl ?? fetch));
  const overrideWarning = formatOverrideWarning(source);
  if (overrideWarning) logWarn(overrideWarning);

  const script = buildUpdateAppScript(opts.app, source);
  if (!opts.apply) {
    return { script, ran: false, source };
  }
  const result = await runRemote(deps.ssh, deps.inventory, opts.guest, script);
  return { script, ran: true, result, source };
}
