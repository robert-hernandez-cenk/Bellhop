import type { ProxyContext, ProxyRoute } from '../routes.ts';
import type { FileSpec } from '../file-driver.ts';
import { fileDriver, singleQuote } from '../file-driver.ts';

// Every site this driver manages gets its cert the same way: DNS-01 via
// Cloudflare (the API token is a Caddy-side env var this generator never
// needs to see) with these two resolvers. Not inventory-configurable --
// there's one domain, one DNS provider, one operator. Exported, along with
// the forward-auth literals below, so the admin-API Caddy driver (issue #26,
// src/lib/proxy/caddy-json.ts) renders the same values as JSON rather than
// keeping its own copy.
export const CLOUDFLARE_TOKEN_PLACEHOLDER = '{env.CLOUDFLARE_API_TOKEN}';
export const ACME_DNS_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const TLS_BLOCK = [
  '    tls {',
  `        dns cloudflare ${CLOUDFLARE_TOKEN_PLACEHOLDER}`,
  `        resolvers ${ACME_DNS_RESOLVERS.join(' ')}`,
  '    }',
];

// Authentik's Caddy forward-auth endpoint, the outpost's own path prefix,
// and the identity headers copied from its response onto the request.
export const OUTPOST_AUTH_URI = '/outpost.goauthentik.io/auth/caddy';
export const OUTPOST_PATH_PREFIX = '/outpost.goauthentik.io';
export const AUTHENTIK_COPY_HEADERS = [
  'X-Authentik-Username',
  'X-Authentik-Groups',
  'X-Authentik-Email',
  'X-Authentik-Name',
  'X-Authentik-Uid',
];

// Renders every route into the body of one Caddyfile managed section --
// fileDriver adds the bellhop-managed markers around it. Reads the
// proxy-neutral ProxyRoute/ProxyContext shapes (buildRoutes/
// buildProxyContext have already done the derivation, including the
// missing-authentik throw, by the time render runs), and emits exempt
// paths from auth.rawExemptPaths verbatim rather than reconstructing them
// from the parsed exemptPaths -- so a forward-gated route's `not path ...`
// line is byte-identical to what the operator typed into
// unauthenticatedPaths.
export function render(routes: ProxyRoute[], ctx: ProxyContext, configPath: string): FileSpec[] {
  const lines: string[] = [];
  for (const route of routes) {
    const addresses = route.hostnames.join(', ');
    lines.push(`${addresses} {`);
    lines.push(`    reverse_proxy ${route.backend.ip}:${route.backend.port} {`);
    lines.push(`        header_up X-Forwarded-Port ${ctx.externalPort}`);
    if (route.backend.insecureTls) {
      lines.push('        transport http {');
      lines.push('            tls_insecure_skip_verify');
      lines.push('        }');
    }
    lines.push('    }');
    if (route.auth.mode === 'forward') {
      // ctx.outpost is guaranteed set here: buildRoutes already throws the
      // missing-authentik error before producing a 'forward' route when no
      // authentik:true entry has an ip, and buildProxyContext derives
      // outpost from that same entry.
      const outpostAddr = `${ctx.outpost!.ip}:${ctx.outpost!.port}`;
      const exemptPaths = route.auth.rawExemptPaths;
      if (exemptPaths.length > 0) {
        lines.push('    @auth_required {');
        lines.push(`        not path ${exemptPaths.join(' ')}`);
        lines.push('    }');
        lines.push(`    forward_auth @auth_required ${outpostAddr} {`);
      } else {
        lines.push(`    forward_auth ${outpostAddr} {`);
      }
      lines.push(`        uri ${OUTPOST_AUTH_URI}`);
      lines.push(`        copy_headers ${AUTHENTIK_COPY_HEADERS.join(' ')}`);
      lines.push('    }');
      lines.push(`    handle ${OUTPOST_PATH_PREFIX}/* {`);
      lines.push(`        reverse_proxy ${outpostAddr}`);
      lines.push('    }');
    }
    lines.push(...TLS_BLOCK);
    lines.push('}');
  }
  return [{ path: configPath, content: lines.join('\n'), mode: 'managed-section' }];
}

// Also the Caddyfile convert-caddyfile (issue #26) reads by default.
export const CADDYFILE_DEFAULT_PATH = '/etc/caddy/Caddyfile';

export const caddyDriver = fileDriver({
  id: 'caddy',
  label: 'Caddy',
  capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
  defaultConfigPath: CADDYFILE_DEFAULT_PATH,
  // The Caddy package's default document root -- what render-status-page's
  // caddy.example.com block already serves via file_server (see CLAUDE.md's
  // render-status-page bullet), and the placeholder the Settings page shows.
  statusPage: { suggestedPath: '/usr/share/caddy/index.html' },
  configPathNote: 'Only the bellhop-managed section of this file is replaced; everything outside it is left alone.',
  render,
  validateCommand: (configPath) => `caddy validate --adapter caddyfile --config ${singleQuote(configPath)}`,
  reloadCommand: 'systemctl reload caddy',
});
