import { z } from 'zod';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import {
  ACME_DNS_RESOLVERS,
  AUTHENTIK_COPY_HEADERS,
  CLOUDFLARE_TOKEN_PLACEHOLDER,
  OUTPOST_AUTH_URI,
  OUTPOST_PATH_PREFIX,
} from './drivers/caddy.ts';

// Pure half of the admin-API Caddy driver (issue #26): renders inventory
// routes as Caddy JSON and reconciles them against a live configuration.
// No remote calls here -- src/lib/proxy/caddy-admin.ts reads and writes the
// configuration, and both the driver (drivers/caddy-api.ts) and
// convert-caddyfile share this planner, so ownership, placement, and
// conflict rules exist exactly once (research R5/R6).

// --- Caddy configuration shapes --------------------------------------------
// Only the paths the planner interprets are typed; every other key is
// carried through untouched (passthrough), since the configuration also
// holds the operator's own hand-authored objects.

const HostMatchSchema = z.object({ host: z.array(z.string()).optional() }).passthrough();
const RouteSchema = z
  .object({ '@id': z.string().optional(), match: z.array(HostMatchSchema).optional() })
  .passthrough();
const ServerSchema = z
  .object({ listen: z.array(z.string()).optional(), routes: z.array(RouteSchema).optional() })
  .passthrough();
const TlsPolicySchema = z.object({ '@id': z.string().optional(), subjects: z.array(z.string()).optional() }).passthrough();
const ConfigObjectSchema = z
  .object({
    apps: z
      .object({
        http: z.object({ servers: z.record(ServerSchema).optional() }).passthrough().optional(),
        tls: z
          .object({
            automation: z.object({ policies: z.array(TlsPolicySchema).optional() }).passthrough().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Caddy's GET /config/ body: null for an empty Caddy, otherwise an object.
export const CaddyConfigSchema = z.union([z.null(), ConfigObjectSchema]);

export type CaddyRoute = z.infer<typeof RouteSchema>;
export type CaddyServer = z.infer<typeof ServerSchema>;
export type CaddyTlsPolicy = z.infer<typeof TlsPolicySchema>;
export type CaddyConfigObject = z.infer<typeof ConfigObjectSchema>;
export type CaddyConfig = CaddyConfigObject | null;

// --- Rendering -------------------------------------------------------------

// Every object this driver creates carries an @id with this prefix, and an
// object is Bellhop's if and only if it does (FR-006).
export const BELLHOP_ID_PREFIX = 'bellhop-';
export const BELLHOP_TLS_POLICY_ID = 'bellhop-tls';

export function routeId(route: ProxyRoute): string {
  return `${BELLHOP_ID_PREFIX}route-${route.hostnames[0]}`;
}

function isBellhopObject(obj: { '@id'?: string }): boolean {
  return typeof obj['@id'] === 'string' && obj['@id'].startsWith(BELLHOP_ID_PREFIX);
}

// Caddy's adapter turns `forward_auth ... { uri ...; copy_headers ... }`
// into this reverse_proxy (captured in
// test/fixtures/caddy/characterization-adapted.json): a GET to the outpost's
// auth endpoint whose 2xx response runs a `vars` handler, then copies each
// header -- in sorted order -- onto the request only when the outpost sent
// it.
function forwardAuthHandler(outpost: string): Record<string, unknown> {
  const copyRoutes = [...AUTHENTIK_COPY_HEADERS].sort().map((header) => {
    const placeholder = `{http.reverse_proxy.header.${header}}`;
    return {
      handle: [{ handler: 'headers', request: { set: { [header]: [placeholder] } } }],
      match: [{ not: [{ vars: { [placeholder]: [''] } }] }],
    };
  });
  return {
    handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: 'vars' }] }, ...copyRoutes] }],
    handler: 'reverse_proxy',
    headers: { request: { set: { 'X-Forwarded-Method': ['{http.request.method}'], 'X-Forwarded-Uri': ['{http.request.uri}'] } } },
    rewrite: { method: 'GET', uri: OUTPOST_AUTH_URI },
    upstreams: [{ dial: outpost }],
  };
}

// One route per ProxyRoute, shaped exactly like the route Caddy's adapter
// produces from the file-based driver's site block for the same route
// (research R1): a host-matched, terminal route with one subroute holding,
// in the adapter's directive order, forward_auth (behind the `not path`
// matcher when there are exempt paths), the outpost passthrough, then the
// backend reverse_proxy.
export function renderRoute(route: ProxyRoute, ctx: ProxyContext): CaddyRoute {
  const subroutes: Record<string, unknown>[] = [];
  if (route.auth.mode === 'forward') {
    // ctx.outpost is guaranteed set here: buildRoutes already throws the
    // missing-authentik error before producing a 'forward' route when no
    // authentik:true entry has an ip -- the same guarantee drivers/caddy.ts
    // relies on.
    const outpost = `${ctx.outpost!.ip}:${ctx.outpost!.port}`;
    const authRoute: Record<string, unknown> = { handle: [forwardAuthHandler(outpost)] };
    if (route.auth.rawExemptPaths.length > 0) {
      authRoute.match = [{ not: [{ path: route.auth.rawExemptPaths }] }];
    }
    subroutes.push(authRoute);
    subroutes.push({
      handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: outpost }] }] }] }],
      match: [{ path: [`${OUTPOST_PATH_PREFIX}/*`] }],
    });
  }
  subroutes.push({
    handle: [
      {
        handler: 'reverse_proxy',
        headers: { request: { set: { 'X-Forwarded-Port': [String(ctx.externalPort)] } } },
        ...(route.backend.insecureTls ? { transport: { protocol: 'http', tls: { insecure_skip_verify: true } } } : {}),
        upstreams: [{ dial: `${route.backend.ip}:${route.backend.port}` }],
      },
    ],
  });
  return {
    '@id': routeId(route),
    match: [{ host: route.hostnames }],
    handle: [{ handler: 'subroute', routes: subroutes }],
    terminal: true,
  };
}

// The one automation policy for every Bellhop hostname: Cloudflare DNS-01
// with the same token placeholder and resolvers as the file-based driver's
// TLS_BLOCK, which the adapter merges into exactly this shape.
export function renderTlsPolicy(hostnames: string[]): CaddyTlsPolicy {
  return {
    '@id': BELLHOP_TLS_POLICY_ID,
    subjects: hostnames,
    issuers: [
      {
        challenges: {
          dns: { provider: { api_token: CLOUDFLARE_TOKEN_PLACEHOLDER, name: 'cloudflare' }, resolvers: ACME_DNS_RESOLVERS },
        },
        module: 'acme',
      },
    ],
  };
}

// --- Planning --------------------------------------------------------------

// Structural JSON with object keys sorted at every level: Caddy's GET
// /config/ returns keys sorted, so comparing a live object with a freshly
// rendered one must ignore key order.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export interface CaddyConflict {
  hostname: string;
  owner: ProxyRoute['owner'];
  claimedBy: 'route' | 'tls-policy';
  // The server holding the claiming route; absent for a TLS policy.
  server?: string;
}

export interface CaddyChange {
  kind: 'add' | 'replace' | 'remove' | 'reorder';
  object: 'route' | 'tls-policy';
  hostnames: string[];
  // add/replace of a route only: its preview details.
  route?: ProxyRoute;
}

export interface CaddyConfigPlan {
  // The complete configuration to write, or null when it would equal the
  // current one (nothing to write).
  config: CaddyConfigObject | null;
  changes: CaddyChange[];
  conflicts: CaddyConflict[];
  // Every Bellhop object in the planned configuration, in write order --
  // what the preview prints.
  bellhopObjects: Array<CaddyRoute | CaddyTlsPolicy>;
}

// A listen address on port 443 (":443", "0.0.0.0:443", "[::]:443",
// "tcp/:443").
function listensOnHttps(server: CaddyServer): boolean {
  return (server.listen ?? []).some((address) => /:443$/.test(address));
}

function routeHosts(route: CaddyRoute): string[] {
  return (route.match ?? []).flatMap((m) => m.host ?? []);
}

// The server Bellhop's routes belong in: the single one listening on 443.
// An empty configuration (no servers at all) gets srv0, the adapter's own
// first server name; 0 HTTPS servers among existing ones, or more than one,
// is an error -- there is no safe guess (spec edge case "Several HTTPS
// servers").
function targetServer(servers: Record<string, CaddyServer>, host: string): string {
  const names = Object.keys(servers);
  if (names.length === 0) {
    servers.srv0 = { listen: [':443'], routes: [] };
    return 'srv0';
  }
  const https = names.filter((name) => listensOnHttps(servers[name]));
  if (https.length !== 1) {
    throw new Error(
      `Caddy's configuration on '${host}' has ${https.length} servers listening on port 443 (${https.join(', ') || 'none'}); ` +
        'the caddy-api driver needs exactly one to hold its routes.'
    );
  }
  return https[0];
}

// Reconciles the desired routes against the live configuration (research
// R5/R6): strips every Bellhop object, leaves out routes whose hostnames an
// untagged object already claims (conflicts), prepends the rest -- routes
// to the HTTPS server, the TLS policy to the automation policies -- and
// reports what changed. The input is never mutated.
export function planCaddyConfig(
  current: CaddyConfig,
  routes: ProxyRoute[],
  ctx: ProxyContext,
  host: string
): CaddyConfigPlan {
  const config: CaddyConfigObject = current === null ? {} : (JSON.parse(JSON.stringify(current)) as CaddyConfigObject);
  const servers: Record<string, CaddyServer> = config.apps?.http?.servers ?? {};
  const policies: CaddyTlsPolicy[] = config.apps?.tls?.automation?.policies ?? [];

  // Existing Bellhop objects, for change detection.
  const existingRoutes = new Map<string, CaddyRoute>();
  for (const server of Object.values(servers)) {
    for (const r of server.routes ?? []) {
      // isBellhopObject has just checked that @id is a string.
      if (isBellhopObject(r)) existingRoutes.set(r['@id']!, r);
    }
  }
  const existingPolicy = policies.find(isBellhopObject);

  // Conflicts: an untagged route (any server) or policy naming the hostname
  // exactly, case-insensitively. Wildcards never match here.
  const claims = new Map<string, Omit<CaddyConflict, 'hostname' | 'owner'>>();
  for (const [name, server] of Object.entries(servers)) {
    for (const r of server.routes ?? []) {
      if (isBellhopObject(r)) continue;
      for (const h of routeHosts(r)) {
        if (!claims.has(h.toLowerCase())) claims.set(h.toLowerCase(), { claimedBy: 'route', server: name });
      }
    }
  }
  for (const p of policies) {
    if (isBellhopObject(p)) continue;
    for (const h of p.subjects ?? []) {
      if (!claims.has(h.toLowerCase())) claims.set(h.toLowerCase(), { claimedBy: 'tls-policy' });
    }
  }
  const conflicts: CaddyConflict[] = [];
  const kept: ProxyRoute[] = [];
  for (const route of routes) {
    const claimed = route.hostnames.find((h) => claims.has(h.toLowerCase()));
    if (claimed === undefined) {
      kept.push(route);
      continue;
    }
    // claims.has() was just true for this key in the find() above.
    conflicts.push({ hostname: claimed, owner: route.owner, ...claims.get(claimed.toLowerCase())! });
  }

  const desiredRoutes = kept.map((r) => renderRoute(r, ctx));
  const desiredPolicy = kept.length > 0 ? renderTlsPolicy(kept.flatMap((r) => r.hostnames)) : undefined;

  // Strip every Bellhop object.
  for (const server of Object.values(servers)) {
    if (server.routes) server.routes = server.routes.filter((r) => !isBellhopObject(r));
  }
  const operatorPolicies = policies.filter((p) => !isBellhopObject(p));

  // Prepend the desired objects.
  if (desiredRoutes.length > 0) {
    config.apps ??= {};
    config.apps.http ??= {};
    config.apps.http.servers ??= servers;
    const target = targetServer(config.apps.http.servers, host);
    const server = config.apps.http.servers[target];
    server.routes = [...desiredRoutes, ...(server.routes ?? [])];
  }
  const newPolicies = desiredPolicy ? [desiredPolicy, ...operatorPolicies] : operatorPolicies;
  if (newPolicies.length > 0) {
    config.apps ??= {};
    config.apps.tls ??= {};
    config.apps.tls.automation ??= {};
    config.apps.tls.automation.policies = newPolicies;
  } else if (existingPolicy && config.apps?.tls?.automation) {
    // The Bellhop policy was the only one: prune the containers it leaves
    // empty rather than writing `policies: []` Caddy never had before.
    delete config.apps.tls.automation.policies;
    if (Object.keys(config.apps.tls.automation).length === 0) delete config.apps.tls.automation;
    if (Object.keys(config.apps.tls).length === 0) delete config.apps.tls;
  }

  const changes: CaddyChange[] = [];
  const desiredIds = new Set<string>();
  kept.forEach((route, i) => {
    const id = routeId(route);
    desiredIds.add(id);
    const before = existingRoutes.get(id);
    if (!before) changes.push({ kind: 'add', object: 'route', hostnames: route.hostnames, route });
    else if (canonicalJson(before) !== canonicalJson(desiredRoutes[i])) {
      changes.push({ kind: 'replace', object: 'route', hostnames: route.hostnames, route });
    }
  });
  for (const [id, before] of existingRoutes) {
    if (!desiredIds.has(id)) changes.push({ kind: 'remove', object: 'route', hostnames: routeHosts(before) });
  }
  if (desiredPolicy && !existingPolicy) {
    changes.push({ kind: 'add', object: 'tls-policy', hostnames: desiredPolicy.subjects ?? [] });
  } else if (desiredPolicy && existingPolicy && canonicalJson(desiredPolicy) !== canonicalJson(existingPolicy)) {
    changes.push({ kind: 'replace', object: 'tls-policy', hostnames: desiredPolicy.subjects ?? [] });
  } else if (!desiredPolicy && existingPolicy) {
    changes.push({ kind: 'remove', object: 'tls-policy', hostnames: existingPolicy.subjects ?? [] });
  }

  const changed = canonicalJson(config) !== canonicalJson(current ?? {});
  if (changed && changes.length === 0) {
    // Same objects, different position (e.g. an operator moved a Bellhop
    // route behind their own) -- still a write, so still a listed change.
    changes.push({ kind: 'reorder', object: 'route', hostnames: [] });
  }

  return {
    config: changed ? config : null,
    changes,
    conflicts,
    bellhopObjects: [...desiredRoutes, ...(desiredPolicy ? [desiredPolicy] : [])],
  };
}

// --- Messages --------------------------------------------------------------

export const NO_CHANGES_MESSAGE = "No changes: Caddy's configuration already matches the inventory.";

function routeDetails(route: ProxyRoute): string {
  const flags: string[] = [];
  if (route.backend.insecureTls) flags.push('insecure backend TLS');
  if (route.auth.mode === 'forward') {
    const n = route.auth.rawExemptPaths.length;
    flags.push(n > 0 ? `forward-auth, ${n} exempt path${n === 1 ? '' : 's'}` : 'forward-auth');
  } else if (route.auth.mode === 'oidc') {
    flags.push('OIDC');
  }
  const target = ` -> ${route.backend.ip}:${route.backend.port}`;
  return flags.length > 0 ? `${target} (${flags.join(', ')})` : target;
}

const SYMBOLS: Record<CaddyChange['kind'], string> = { add: '+', replace: '~', remove: '-', reorder: '~' };

function conflictClaim(c: CaddyConflict): string {
  return c.claimedBy === 'route' ? `a hand-authored route in server '${c.server}'` : 'a hand-authored TLS automation policy';
}

// The preview contract (contracts/commands-and-messages.md): one line per
// change and conflict, then the Bellhop objects exactly as they'll be
// written.
export function formatCaddyPreview(plan: CaddyConfigPlan): string {
  if (plan.config === null && plan.conflicts.length === 0) return NO_CHANGES_MESSAGE;
  const lines: string[] = [];
  for (const change of plan.changes) {
    const symbol = SYMBOLS[change.kind];
    if (change.object === 'tls-policy') {
      lines.push(
        change.kind === 'remove' ? `${symbol} tls policy` : `${symbol} tls policy: ${change.hostnames.length} hostnames`
      );
    } else if (change.kind === 'reorder') {
      lines.push(`${symbol} move Bellhop routes ahead of hand-authored routes`);
    } else {
      const details = change.route ? routeDetails(change.route) : '';
      lines.push(`${symbol} route ${change.hostnames.join(', ')}${details}`);
    }
  }
  for (const c of plan.conflicts) {
    lines.push(`! conflict ${c.hostname} (entry '${c.owner.name}'): claimed by ${conflictClaim(c)}`);
  }
  if (plan.config === null) {
    lines.push('', 'Nothing else to change.');
  } else {
    lines.push('', 'Bellhop objects after this change:', JSON.stringify(plan.bellhopObjects, null, 2));
  }
  return lines.join('\n');
}

// Thrown by apply() after the non-conflicting changes were written (FR-007).
export function formatConflictError(conflicts: CaddyConflict[], host: string): string {
  return conflicts
    .map(
      (c) =>
        `Hostname '${c.hostname}' for entry '${c.owner.name}' is already claimed by ${conflictClaim(c)} in Caddy's ` +
        `configuration on '${host}'; it was left out. Remove or change that object, or mark the entry proxyManual.`
    )
    .join('\n');
}
