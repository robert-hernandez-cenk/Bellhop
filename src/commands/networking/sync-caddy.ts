import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { buildRoutes, buildProxyContext } from '../../lib/proxy/routes.ts';
import { render as renderCaddy, caddyDriver } from '../../lib/proxy/drivers/caddy.ts';

const BEGIN_MARKER = '# BEGIN bellhop-managed';
const END_MARKER = '# END bellhop-managed';

export interface SyncCaddyOptions {
  apply?: boolean;
  caddyfilePath?: string;
}

// Delegates to the same buildRoutes -> buildProxyContext -> render pipeline
// the src/lib/proxy/drivers/caddy.ts driver uses (issue #10, T010) -- kept
// here, under its old name/shape, only because T013 (a later batch) is what
// rewrites runSyncCaddy itself into orchestration over the driver registry.
// caddyDriver.defaultConfigPath is passed through as the render path even
// though nothing here reads FileSpec.path -- render's only externally
// visible output at this call site is the managed-section content string.
export function buildCaddyBlock(inventory: Inventory): string {
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory);
  return renderCaddy(routes, ctx, caddyDriver.defaultConfigPath)[0].content;
}

// Local single-quote escaping for embedding a path into the generated
// remote shell script -- kept local rather than importing ssh-client.ts's
// shellQuote since this quotes a config *path*, not a whole command being
// forwarded to a remote shell, and doesn't need that module's dependency.
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRemoteScript(caddyfilePath: string, block: string): string {
  const p = singleQuote(caddyfilePath);
  return [
    'set -e',
    'TMP_CADDYFILE="$(mktemp)"',
    `if [ -f ${p} ] && grep -q '${BEGIN_MARKER}' ${p} 2>/dev/null; then`,
    `  sed '/${BEGIN_MARKER}/,/${END_MARKER}/d' ${p} > "$TMP_CADDYFILE"`,
    `elif [ -f ${p} ]; then`,
    `  cp ${p} "$TMP_CADDYFILE"`,
    'else',
    '  : > "$TMP_CADDYFILE"',
    'fi',
    `cat >> "$TMP_CADDYFILE" <<'BLOCK'`,
    block,
    'BLOCK',
    'if ! caddy validate --adapter caddyfile --config "$TMP_CADDYFILE"; then',
    `  echo "Caddyfile validation failed; leaving ${caddyfilePath} unchanged" >&2`,
    '  rm -f "$TMP_CADDYFILE"',
    '  exit 1',
    'fi',
    `cat "$TMP_CADDYFILE" > ${p} && rm -f "$TMP_CADDYFILE"`,
    'systemctl reload caddy',
  ].join('\n');
}

export async function runSyncCaddy(
  opts: SyncCaddyOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ caddyHost: string; block: string; applied: boolean }> {
  const caddyfilePath = opts.caddyfilePath ?? '/etc/caddy/Caddyfile';
  const caddyHost = [...deps.inventory.hosts, ...deps.inventory.guests].find((e) => e.caddy)?.name;
  if (!caddyHost) {
    throw new Error("No inventory entry has 'caddy: true'");
  }

  const block = buildCaddyBlock(deps.inventory);
  if (!opts.apply) {
    return { caddyHost, block, applied: false };
  }

  const script = buildRemoteScript(caddyfilePath, block);
  await runRemote(deps.ssh, deps.inventory, caddyHost, script);
  return { caddyHost, block, applied: true };
}
