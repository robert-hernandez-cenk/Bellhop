import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { effectiveAuth } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { authentikConfig } from '../../lib/authentik-config.ts';

const BEGIN_MARKER = '# BEGIN bellhop-managed';
const END_MARKER = '# END bellhop-managed';

export interface SyncCaddyOptions {
  apply?: boolean;
  caddyfilePath?: string;
}

// Every site this toolkit's Caddy manages gets its cert the same way: DNS-01
// via Cloudflare (the API token is a Caddy-side env var this generator never
// needs to see) with these two resolvers. Not inventory-configurable --
// there's one domain, one DNS provider, one operator.
const TLS_BLOCK = ['    tls {', '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}', '        resolvers 1.1.1.1 8.8.8.8', '    }'];

// Every site sync-caddy manages is reached externally over HTTPS on 443 --
// not inventory-configurable, same rationale as TLS_BLOCK above.
const EXTERNAL_PORT = 443;

interface CaddyTarget {
  name: string;
  ip?: string;
  port?: number;
  subdomains?: string[];
  insecureBackendTls?: boolean;
  caddyManual?: boolean;
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
  unauthenticatedPaths?: string[];
}

export function buildCaddyBlock(inventory: Inventory): string {
  const lines = [BEGIN_MARKER];
  const targets: CaddyTarget[] = [...inventory.hosts, ...inventory.guests, ...(inventory.externalSites ?? [])];
  const authentikEntry = [...inventory.hosts, ...inventory.guests].find((e) => e.authentik);
  // The embedded outpost's forward-auth port -- see the authentik: true
  // inventory flag (src/lib/inventory.ts), which marks which host/guest
  // entry actually runs it.
  const outpostPort = authentikConfig().outpostPort;
  for (const entry of targets) {
    if (entry.caddyManual) continue;
    const subdomains = entry.subdomains ?? [];
    if (subdomains.length === 0) continue;
    const port = entry.port ?? 80;
    const gatedForward = effectiveAuth(entry) === 'forward';
    if (gatedForward && !authentikEntry?.ip) {
      throw new Error(
        `Entry '${entry.name}' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set`
      );
    }
    // One comma-separated site address list per entry, not one block per
    // subdomain -- matches the hand-authored style already live in
    // production (e.g. `sonarr.example.com, shows.example.com { ... }`) and
    // avoids repeating the same reverse_proxy/tls directives once per alias.
    const addresses = subdomains.map((s) => `${s}.${inventory.domain}`).join(', ');
    lines.push(`${addresses} {`);
    lines.push(`    reverse_proxy ${entry.ip}:${port} {`);
    lines.push(`        header_up X-Forwarded-Port ${EXTERNAL_PORT}`);
    if (entry.insecureBackendTls) {
      lines.push('        transport http {');
      lines.push('            tls_insecure_skip_verify');
      lines.push('        }');
    }
    lines.push('    }');
    if (gatedForward) {
      const outpostAddr = `${authentikEntry!.ip}:${outpostPort}`;
      const exemptPaths = entry.unauthenticatedPaths ?? [];
      if (exemptPaths.length > 0) {
        lines.push('    @auth_required {');
        lines.push(`        not path ${exemptPaths.join(' ')}`);
        lines.push('    }');
        lines.push(`    forward_auth @auth_required ${outpostAddr} {`);
      } else {
        lines.push(`    forward_auth ${outpostAddr} {`);
      }
      lines.push('        uri /outpost.goauthentik.io/auth/caddy');
      lines.push('        copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid');
      lines.push('    }');
      lines.push('    handle /outpost.goauthentik.io/* {');
      lines.push(`        reverse_proxy ${outpostAddr}`);
      lines.push('    }');
    }
    lines.push(...TLS_BLOCK);
    lines.push('}');
  }
  lines.push(END_MARKER);
  return lines.join('\n');
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
