import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { getDriver, driverDeps } from '../../lib/proxy/index.ts';
import type { DriverDeps } from '../../lib/proxy/driver.ts';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildStatusPageHtml(hostsYaml: string, deployedProxyConfig: string): string {
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
    '<h2>Deployed proxy configuration</h2>',
    `<pre>${escapeHtml(deployedProxyConfig)}</pre>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// Shared by the two callers that treat an unset statusPagePath as an
// opt-in skip rather than a hard failure (syncProxyLive in
// src/web/proxy-sync.ts, and migrate-guest's own post-migration proxy
// push) -- both already import from this module for runRenderStatusPage,
// so this is the natural place to keep their skip message in sync with
// the remedy runRenderStatusPage's own throw below names, rather than
// hand-duplicating the string at each call site.
export function statusPagePathSkipMessage(): string {
  return 'statusPagePath is not set -- skipping the status page render -- run: bellhop set-config statusPagePath </absolute/path> --apply';
}

function buildWriteScript(statusPagePath: string, html: string): string {
  return ['set -e', `cat > ${shellQuote(statusPagePath)} <<'STATUS_PAGE_EOF'`, html, 'STATUS_PAGE_EOF'].join('\n');
}

export interface RenderStatusPageOptions {
  apply?: boolean;
}

// Regenerates the static page served at the proxy host's document root
// from a live re-render of inventory/bellhop.db plus whatever's
// actually deployed on the proxy host right now -- a manual, on-demand
// command, not something sync-proxy triggers automatically. Opt-in: an
// operator who hasn't set statusPagePath never gets an index.html written
// anywhere (see syncProxyLive in src/web/proxy-sync.ts for the web push-live
// step, which skips this instead of throwing).
//
// Reads the live-deployed config through the active driver's own
// snapshot() (issue #10, T014) rather than a hardcoded `cat` of a
// driver-specific config path -- so this page shows whatever the active
// driver actually manages, and its own failure message ("Failed to read
// the deployed proxy configuration from '<host>': …") comes from that one
// shared implementation (src/lib/proxy/file-driver.ts) instead of being
// duplicated here.
export async function runRenderStatusPage(
  opts: RenderStatusPageOptions,
  deps: { ssh: SSHClient; inventory: Inventory },
  hostsYamlText: string
): Promise<{ proxyHost: string; html: string; applied: boolean }> {
  const statusPagePath = deps.inventory.statusPagePath;
  if (statusPagePath === undefined) {
    throw new Error(
      'statusPagePath is not set -- run: bellhop set-config statusPagePath </absolute/path> --apply'
    );
  }

  const driver = getDriver(deps.inventory);
  const resolvedDeps: DriverDeps = driverDeps(deps.inventory, deps.ssh, driver);
  const proxyHost = resolvedDeps.proxyHost;

  const activeConfig = await driver.snapshot(resolvedDeps);

  const html = buildStatusPageHtml(hostsYamlText, activeConfig);

  const applied = confirmOrDryRun(`Would write status page to ${proxyHost}:${statusPagePath}`, opts.apply ?? false);
  if (applied) {
    const writeResult = await runRemote(deps.ssh, deps.inventory, proxyHost, buildWriteScript(statusPagePath, html));
    if (writeResult.code !== 0) {
      throw new Error(
        `Failed to write status page on ${proxyHost} (exit ${writeResult.code}): ${writeResult.stderr || writeResult.stdout}`
      );
    }
  }
  return { proxyHost, html, applied };
}
