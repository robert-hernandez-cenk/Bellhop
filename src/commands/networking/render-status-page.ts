import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { findCaddyEntry } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { settingFix } from '../../lib/settings-hint.ts';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildStatusPageHtml(hostsYaml: string, activeCaddyfile: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Homelab status</title>',
    '<style>body{font-family:monospace;margin:2rem;background:#111;color:#eee}pre{background:#1c1c1c;padding:1rem;overflow-x:auto;border-radius:6px;white-space:pre-wrap;word-break:break-word}h2{margin-top:2rem}</style>',
    '</head>',
    '<body>',
    '<h1>Homelab status</h1>',
    '<h2>inventory (generated from bellhop.db)</h2>',
    `<pre>${escapeHtml(hostsYaml)}</pre>`,
    '<h2>Active Caddyfile</h2>',
    `<pre>${escapeHtml(activeCaddyfile)}</pre>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// Shared by the two callers that treat an unset statusPagePath as an
// opt-in skip rather than a hard failure (syncCaddyLive in
// src/web/caddy-sync.ts, and migrate-guest's own post-migration Caddy
// push) -- both already import from this module for runRenderStatusPage,
// so this is the natural place to keep their skip message in sync with
// the remedy runRenderStatusPage's own throw below names, rather than
// hand-duplicating the string at each call site.
export function statusPagePathSkipMessage(): string {
  return `statusPagePath is not set -- skipping the status page render -- ${settingFix('statusPagePath', '</absolute/path>')}`;
}

function buildWriteScript(statusPagePath: string, html: string): string {
  return ['set -e', `cat > ${shellQuote(statusPagePath)} <<'STATUS_PAGE_EOF'`, html, 'STATUS_PAGE_EOF'].join('\n');
}

export interface RenderStatusPageOptions {
  apply?: boolean;
  caddyfilePath?: string;
}

// Regenerates the static page served at the Caddy host's document root
// from a live re-render of inventory/bellhop.db plus whatever's
// actually deployed on the Caddy host right now -- a manual, on-demand
// command, not something sync-caddy triggers automatically. Opt-in: an
// operator who hasn't set statusPagePath never gets an index.html written
// anywhere (see syncCaddyLive in src/web/caddy-sync.ts for the web push-live
// step, which skips this instead of throwing).
export async function runRenderStatusPage(
  opts: RenderStatusPageOptions,
  deps: { ssh: SSHClient; inventory: Inventory },
  hostsYamlText: string
): Promise<{ caddyHost: string; html: string; applied: boolean }> {
  const statusPagePath = deps.inventory.statusPagePath;
  if (statusPagePath === undefined) {
    throw new Error(`statusPagePath is not set -- ${settingFix('statusPagePath', '</absolute/path>')}`);
  }
  const caddyHost = findCaddyEntry(deps.inventory)?.name;
  if (!caddyHost) {
    throw new Error("No inventory entry has 'caddy: true'");
  }
  // Reads whichever Caddyfile sync-caddy writes to, rather than assuming
  // /etc/caddy/Caddyfile -- otherwise this page can display a different
  // file than the one syncCaddyLive just updated in the same step.
  const caddyfilePath = opts.caddyfilePath ?? '/etc/caddy/Caddyfile';

  const caddyfileResult = await runRemote(
    deps.ssh,
    deps.inventory,
    caddyHost,
    `cat ${shellQuote(caddyfilePath)}`
  );
  if (caddyfileResult.code !== 0) {
    throw new Error(
      `Failed to read the active Caddyfile from ${caddyHost} (exit ${caddyfileResult.code}): ${caddyfileResult.stderr || caddyfileResult.stdout}`
    );
  }

  const html = buildStatusPageHtml(hostsYamlText, caddyfileResult.stdout);

  const applied = confirmOrDryRun(`Would write status page to ${caddyHost}:${statusPagePath}`, opts.apply ?? false);
  if (applied) {
    const writeResult = await runRemote(deps.ssh, deps.inventory, caddyHost, buildWriteScript(statusPagePath, html));
    if (writeResult.code !== 0) {
      throw new Error(
        `Failed to write status page on ${caddyHost} (exit ${writeResult.code}): ${writeResult.stderr || writeResult.stdout}`
      );
    }
  }
  return { caddyHost, html, applied };
}
