import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { findProxyEntry } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { singleQuote } from '../../lib/proxy/file-driver.ts';
import { buildRoutes, buildProxyContext } from '../../lib/proxy/routes.ts';
import { checkCapabilities } from '../../lib/proxy/driver.ts';
import { getDriver } from '../../lib/proxy/index.ts';
import { caddyDriver, CADDYFILE_DEFAULT_PATH } from '../../lib/proxy/drivers/caddy.ts';
import { caddyApiDriver } from '../../lib/proxy/drivers/caddy-api.ts';
import { readCaddyConfig, writeCaddyConfig } from '../../lib/proxy/caddy-admin.ts';
import {
  BELLHOP_ID_PREFIX,
  CaddyConfigSchema,
  formatCaddyPreview,
  formatConflictError,
  planCaddyConfig,
  type CaddyConfig,
  type CaddyConflict,
} from '../../lib/proxy/caddy-json.ts';

// One-time switch from the file-based Caddy driver to the admin-API one
// (issue #26, spec User Story 5/FR-015): converts the proxy host's
// Caddyfile -- minus Bellhop's managed section -- with Caddy's own adapter,
// adds the inventory's routes as Bellhop-tagged ones through the same
// planner sync-proxy uses, and loads the result into the running Caddy.
// Caddy autosaves every loaded configuration, which is what the
// caddy-api.service unit resumes from once the operator switches to it.

export interface ConvertCaddyfileOptions {
  caddyfile?: string;
  apply?: boolean;
}

export interface ConvertCaddyfileResult {
  proxyHost: string;
  caddyfile: string;
  preview: string;
  conflicts: CaddyConflict[];
  applied: boolean;
}

// Exit code the adapt command uses for a missing Caddyfile.
export const MISSING_CADDYFILE_EXIT = 5;

// Copies the Caddyfile minus the bellhop-managed block (the same sed range
// buildFileDriverScript strips) to a temp file in the *same directory*, so
// relative `import`s still resolve, and adapts that. An empty remainder is
// `null` -- Caddy's own empty configuration.
export function buildAdaptCommand(caddyfile: string): string {
  return [
    `F=${singleQuote(caddyfile)}`,
    `[ -f "$F" ] || exit ${MISSING_CADDYFILE_EXIT}`,
    'T="$(mktemp "$(dirname "$F")/.bellhop-convert.XXXXXX")"',
    `trap 'rm -f "$T"' EXIT`,
    `sed '/# BEGIN bellhop-managed/,/# END bellhop-managed/d' "$F" > "$T"`,
    `if grep -q '[^[:space:]]' "$T"; then caddy adapt --adapter caddyfile --config "$T"; else echo null; fi`,
  ].join('\n');
}

export function nextSteps(host: string): string {
  return [
    `Loaded the converted configuration into Caddy on ${host}. Next:`,
    `  1. On ${host}: systemctl disable --now caddy && systemctl enable --now caddy-api`,
    '  2. bellhop set-config proxyDriver caddy-api --apply',
    'The Caddyfile was left unchanged.',
  ].join('\n');
}

// The Caddyfile this converts: --caddyfile, else the proxyConfigPath
// setting when it belongs to the file-based Caddy driver (the one being
// switched away from), else that driver's own default.
function resolveCaddyfile(opts: ConvertCaddyfileOptions, inventory: Inventory): string {
  if (opts.caddyfile) return opts.caddyfile;
  if (getDriver(inventory).id === caddyDriver.id && inventory.proxyConfigPath) return inventory.proxyConfigPath;
  return CADDYFILE_DEFAULT_PATH;
}

// Any object the caddy-api driver tags as its own: a route or a connection
// policy on any server, the automation policy, or (issue #51 'files' mode)
// the load_files entry -- a leftover of any one kind means Caddy has
// already been switched over once.
function hasBellhopObjects(config: CaddyConfig): boolean {
  if (config === null) return false;
  const servers = Object.values(config.apps?.http?.servers ?? {});
  const routes = servers.flatMap((s) => s.routes ?? []);
  const connections = servers.flatMap((s) => s.tls_connection_policies ?? []);
  const policies = config.apps?.tls?.automation?.policies ?? [];
  const loadFiles = config.apps?.tls?.certificates?.load_files ?? [];
  return [...routes, ...connections, ...policies, ...loadFiles].some((o) => o['@id']?.startsWith(BELLHOP_ID_PREFIX));
}

function keptSummary(adapted: CaddyConfig, caddyfile: string): string {
  const servers = Object.entries(adapted?.apps?.http?.servers ?? {});
  if (servers.length === 0) {
    return `Hand-authored configuration kept from ${caddyfile}: none (only the Bellhop-managed section was found).`;
  }
  const lines = servers.map(([name, s]) => {
    const n = (s.routes ?? []).length;
    return `  server ${name} (${(s.listen ?? []).join(', ') || 'no listen address'}): ${n} route${n === 1 ? '' : 's'}`;
  });
  return [`Hand-authored configuration kept from ${caddyfile}:`, ...lines].join('\n');
}

export async function runConvertCaddyfile(
  opts: ConvertCaddyfileOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<ConvertCaddyfileResult> {
  const proxyHost = findProxyEntry(deps.inventory)?.name;
  if (!proxyHost) {
    throw new Error("No inventory entry has 'proxy: true'");
  }
  const caddyfile = resolveCaddyfile(opts, deps.inventory);
  const adminDeps = { ssh: deps.ssh, inventory: deps.inventory, proxyHost };

  // The live configuration is only read for its Etag and to refuse a
  // second conversion -- the conversion is for the first switch only, so it
  // can never replace a live API configuration with an old Caddyfile.
  const live = await readCaddyConfig(adminDeps, { checkService: false });
  if (hasBellhopObjects(live.config)) {
    throw new Error(
      `Caddy's configuration on '${proxyHost}' already has Bellhop objects; convert-caddyfile is only for the first switch. ` +
        "Use 'bellhop sync-proxy' instead."
    );
  }

  const adaptResult = await runRemote(deps.ssh, deps.inventory, proxyHost, buildAdaptCommand(caddyfile));
  if (adaptResult.code === MISSING_CADDYFILE_EXIT) {
    throw new Error(`No Caddyfile at ${caddyfile} on '${proxyHost}' -- pass --caddyfile <path>.`);
  }
  if (adaptResult.code !== 0) {
    throw new Error(
      `caddy adapt could not convert ${caddyfile} on '${proxyHost}': ` +
        (adaptResult.stderr.trim() || adaptResult.stdout.trim() || `exit code ${adaptResult.code}`)
    );
  }
  let adaptedJson: unknown;
  try {
    adaptedJson = JSON.parse(adaptResult.stdout);
  } catch {
    throw new Error(`caddy adapt on '${proxyHost}' printed something other than JSON: ${adaptResult.stdout.slice(0, 200)}`);
  }
  const parsedAdapted = CaddyConfigSchema.safeParse(adaptedJson);
  if (!parsedAdapted.success) {
    throw new Error(`caddy adapt on '${proxyHost}' produced an unexpected configuration: ${parsedAdapted.error.issues[0]?.message ?? 'invalid'}`);
  }
  const adapted = parsedAdapted.data;

  // Same route derivation and capability check sync-proxy runs, against the
  // driver being switched to.
  const routes = buildRoutes(deps.inventory);
  const capabilityErrors = checkCapabilities(routes, caddyApiDriver);
  if (capabilityErrors.length > 0) {
    throw new Error(capabilityErrors.map((e) => e.message).join('\n'));
  }
  const plan = planCaddyConfig(adapted, routes, buildProxyContext(deps.inventory), proxyHost);
  // The conversion writes the adapted configuration even when the planner
  // adds nothing to it (plan.config is null only when it equals `adapted`).
  const toWrite = plan.config ?? adapted;

  const preview = [keptSummary(adapted, caddyfile), '', formatCaddyPreview(plan)].join('\n');

  if (opts.apply && toWrite !== null) {
    await writeCaddyConfig(adminDeps, toWrite, live.etag);
  }
  return { proxyHost, caddyfile, preview, conflicts: plan.conflicts, applied: opts.apply === true && toWrite !== null };
}

export function formatConvertCaddyfile(result: ConvertCaddyfileResult): string {
  const lines = [result.preview];
  if (result.applied) lines.push('', nextSteps(result.proxyHost));
  if (result.conflicts.length > 0) lines.push('', formatConflictError(result.conflicts, result.proxyHost));
  return lines.join('\n');
}
