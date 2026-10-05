import type { Inventory } from '../../inventory.ts';
import type { ProxyContext, ProxyRoute } from '../routes.ts';
import { caddyTlsMode } from '../routes.ts';
import type { FileSpec } from '../file-driver.ts';
import { fileDriver, singleQuote } from '../file-driver.ts';

// How each site gets its certificate is a per-deployment choice (issue #51,
// proxyCaddyTls -> ctx.caddyTls). 'cloudflare' -- the default, and the only
// behavior before #51 -- is DNS-01 via Cloudflare with these two resolvers
// (the API token is a Caddy-side env var this generator never needs to
// see); 'letsencrypt' leaves the clause out so Caddy's own automatic HTTPS
// (HTTP-01/TLS-ALPN-01) takes over; 'internal' has Caddy's local CA issue
// it; 'files' serves the operator's own certificate/key pair (ctx.tls, the
// same pair the nginx driver uses). The token placeholder and resolvers are
// exported, along with the forward-auth literals below, so the admin-API
// Caddy driver (issue #26, src/lib/proxy/caddy-json.ts) renders the same
// values as JSON rather than keeping its own copy.
export const CLOUDFLARE_TOKEN_PLACEHOLDER = '{env.CLOUDFLARE_API_TOKEN}';
export const ACME_DNS_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const CLOUDFLARE_TLS_BLOCK = [
  '    tls {',
  `        dns cloudflare ${CLOUDFLARE_TOKEN_PLACEHOLDER}`,
  `        resolvers ${ACME_DNS_RESOLVERS.join(' ')}`,
  '    }',
];

// One Caddyfile token for a certificate/key path (research R6): bare when it
// holds no whitespace, double quote or backslash -- every default certbot
// path, so the common case reads exactly as an operator would type it --
// otherwise a double-quoted token with only `"` escaped as `\"`.
// SettingsSchema only requires an absolute path, so a space is possible.
// Live-verified against Caddy v2.10.2 `caddy adapt`: inside a quoted token
// `\"` is the only escape -- any other backslash is kept literally, so
// doubling one would put two in the adapted path -- and a bare token's
// backslash is not reliable, hence quoting whenever one appears. Known
// residual, not worth handling for a certificate path: a value ending in
// `\` (or with `\` right before a `"`) can't be expressed, since that
// backslash would read as escaping the quote after it.
export function caddyfileToken(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

// The per-site TLS clause for the active mode (contracts/
// rendering-and-settings.md "Caddyfile per-site TLS clause"), placed last in
// every site block where the fixed Cloudflare clause always was.
function tlsClause(ctx: ProxyContext): string[] {
  switch (ctx.caddyTls) {
    case 'cloudflare':
      return CLOUDFLARE_TLS_BLOCK;
    case 'letsencrypt':
      return [];
    case 'internal':
      return ['    tls internal'];
    case 'files':
      return [`    tls ${caddyfileToken(ctx.tls.certificatePath)} ${caddyfileToken(ctx.tls.keyPath)}`];
  }
}

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
    lines.push(...tlsClause(ctx));
    lines.push('}');
  }
  return [{ path: configPath, content: lines.join('\n'), mode: 'managed-section' }];
}

// Also the Caddyfile convert-caddyfile (issue #26) reads by default.
export const CADDYFILE_DEFAULT_PATH = '/etc/caddy/Caddyfile';

// issue #51, User Story 4 (contract "Cloudflare prune decision"): both Caddy
// drivers (file-based and admin-API) obtain a certificate via Cloudflare
// DNS-01 only in the 'cloudflare' caddyTls mode (unset defaults to it) -- the
// other three modes never touch Cloudflare's DNS at all, so
// prune-acme-challenges has nothing to clean up after them. Exported so
// caddy-api.ts's own capabilities object reads the exact same rule rather
// than keeping a second copy that could drift from this one.
export function caddyAcmeDns01ViaCloudflare(inventory: Inventory): boolean {
  return caddyTlsMode(inventory) === 'cloudflare';
}

export const caddyDriver = fileDriver({
  id: 'caddy',
  label: 'Caddy',
  capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: caddyAcmeDns01ViaCloudflare, tlsSources: ['acme-dns', 'acme-http', 'internal', 'files'], defaultTlsSource: 'acme-dns' },
  defaultConfigPath: CADDYFILE_DEFAULT_PATH,
  // The Caddy package's default document root -- what render-status-page's
  // caddy.example.com block already serves via file_server (see CLAUDE.md's
  // render-status-page bullet), and the placeholder the Settings page shows.
  statusPage: { suggestedPath: '/usr/share/caddy/index.html' },
  // issue #51: the Settings page shows the Caddy TLS dropdown for it.
  usesCaddyTls: true,
  configPathNote: 'Only the bellhop-managed section of this file is replaced; everything outside it is left alone.',
  render,
  validateCommand: (configPath) => `caddy validate --adapter caddyfile --config ${singleQuote(configPath)}`,
  reloadCommand: 'systemctl reload caddy',
});
