import { z } from 'zod';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import type { AcmeDnsProvider, TlsSource } from './ids.ts';
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
// A server's TLS connection policy (tlsSource 'files', issues #51, #72). Only @id and
// whether it has a `match` matter to the planner: one with no match is a
// catch-all.
const ConnectionPolicySchema = z
  .object({ '@id': z.string().optional(), match: z.record(z.unknown()).optional() })
  .passthrough();
const ServerSchema = z
  .object({
    listen: z.array(z.string()).optional(),
    routes: z.array(RouteSchema).optional(),
    tls_connection_policies: z.array(ConnectionPolicySchema).optional(),
  })
  .passthrough();
const TlsPolicySchema = z.object({ '@id': z.string().optional(), subjects: z.array(z.string()).optional() }).passthrough();
// An apps.tls.certificates.load_files entry (tlsSource 'files', issues #51, #72).
const LoadFileSchema = z
  .object({
    '@id': z.string().optional(),
    certificate: z.string().optional(),
    key: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();
const ConfigObjectSchema = z
  .object({
    apps: z
      .object({
        http: z.object({ servers: z.record(ServerSchema).optional() }).passthrough().optional(),
        tls: z
          .object({
            automation: z.object({ policies: z.array(TlsPolicySchema).optional() }).passthrough().optional(),
            certificates: z.object({ load_files: z.array(LoadFileSchema).optional() }).passthrough().optional(),
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
export type CaddyLoadFile = z.infer<typeof LoadFileSchema>;
export type CaddyConnectionPolicy = z.infer<typeof ConnectionPolicySchema>;
export type CaddyConfigObject = z.infer<typeof ConfigObjectSchema>;
export type CaddyConfig = CaddyConfigObject | null;

// --- Rendering -------------------------------------------------------------

// Every object this driver creates carries an @id with this prefix, and an
// object is Bellhop's if and only if it does (FR-006).
export const BELLHOP_ID_PREFIX = 'bellhop-';
// The TLS objects (data-model.md "Bellhop TLS objects"): the automation
// policy ('cloudflare'/'internal'), and for 'files' the load_files entry,
// the SNI-matched connection policy selecting it, and a catch-all
// connection policy. The certificate tag is Bellhop's own rather than the
// adapter's cert0, since an operator's own `tls <cert> <key>` site would
// also get cert0 and Bellhop's policy would then select their certificate
// (research R2).
export const BELLHOP_TLS_POLICY_ID = 'bellhop-tls';
export const BELLHOP_TLS_FILES_ID = 'bellhop-tls-files';
export const BELLHOP_TLS_CONNECTION_ID = 'bellhop-tls-connection';
export const BELLHOP_TLS_DEFAULT_ID = 'bellhop-tls-default';
export const BELLHOP_CERT_TAG = 'bellhop-cert';

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

// Bellhop's TLS objects for one TLS source (issues #51, #72) -- exactly what
// Caddy's adapter makes from the file-based driver's per-site clause for the
// same source (research R1, pinned against
// test/fixtures/caddy/tls-*-adapted.json), with Bellhop's @ids and
// certificate tag:
//   - acme-dns: one automation policy, ACME with the acmeDnsProvider's
//     DNS-01 challenge (only Cloudflare today), the same token placeholder
//     and resolvers as the file-based driver's clause;
//   - internal: one automation policy issued by Caddy's internal CA;
//   - files: the certificate/key pair loaded from disk, plus a connection
//     policy selecting it for every Bellhop hostname;
//   - acme-http: nothing -- Caddy's automatic HTTPS needs no TLS app;
//   - external: not supported -- a programming error (externalSourceError).
// The catch-all connection policy the adapter appends after a 'files'
// policy is placed by planCaddyConfig instead (renderDefaultConnectionPolicy),
// since whether it is needed depends on the live server.
export interface CaddyTlsObjects {
  policy?: CaddyTlsPolicy;
  loadFile?: CaddyLoadFile;
  connectionPolicy?: CaddyConnectionPolicy;
}

export function renderTlsObjects(hostnames: string[], ctx: ProxyContext): CaddyTlsObjects {
  switch (ctx.tlsSource) {
    case 'acme-dns':
      return {
        policy: {
          '@id': BELLHOP_TLS_POLICY_ID,
          subjects: hostnames,
          issuers: [
            {
              challenges: {
                dns: {
                  provider: acmeDnsProviderObject(ctx.acmeDnsProvider),
                  resolvers: ACME_DNS_RESOLVERS,
                },
              },
              module: 'acme',
            },
          ],
        },
      };
    case 'internal':
      return { policy: { '@id': BELLHOP_TLS_POLICY_ID, subjects: hostnames, issuers: [{ module: 'internal' }] } };
    case 'files':
      return {
        loadFile: {
          '@id': BELLHOP_TLS_FILES_ID,
          certificate: ctx.tls.certificatePath,
          key: ctx.tls.keyPath,
          tags: [BELLHOP_CERT_TAG],
        },
        connectionPolicy: {
          '@id': BELLHOP_TLS_CONNECTION_ID,
          match: { sni: hostnames },
          certificate_selection: { any_tag: [BELLHOP_CERT_TAG] },
        },
      };
    case 'acme-http':
      return {};
    case 'external':
      throw externalSourceError();
  }
}

// The DNS-01 provider object for one ACME DNS provider -- exhaustive over
// AcmeDnsProvider, so adding a provider to ids.ts fails typecheck here until
// it has one.
function acmeDnsProviderObject(provider: AcmeDnsProvider): { api_token: string; name: string } {
  switch (provider) {
    case 'cloudflare':
      return { api_token: CLOUDFLARE_TOKEN_PLACEHOLDER, name: 'cloudflare' };
  }
}

// Renderer backstop (research R4): checkTlsSource refuses 'external' for
// caddy-api (sync-proxy) and convert-caddyfile before anything is planned,
// so reaching the planner with it is a programming error -- never a
// silently certificate-less configuration.
function externalSourceError(): Error {
  return new Error("caddy-api driver cannot render tlsSource 'external' (checkTlsSource should have refused it)");
}

// Whether Bellhop writes an automation policy of its own under this source
// -- the sources whose untagged operator policies naming a Bellhop hostname
// are conflicts (planCaddyConfig, research R4).
function writesAutomationPolicy(source: TlsSource): boolean {
  switch (source) {
    case 'acme-dns':
    case 'internal':
      return true;
    case 'acme-http':
    case 'files':
      return false;
    case 'external':
      throw externalSourceError();
  }
}

// The adapter's trailing `{}` connection policy: once a server has any
// connection policy, a handshake whose SNI matches none of them is refused,
// so this catch-all keeps every other site on the server working.
export function renderDefaultConnectionPolicy(): CaddyConnectionPolicy {
  return { '@id': BELLHOP_TLS_DEFAULT_ID };
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
  // 'tls-files' is the load_files entry and 'tls-connection' the connection
  // policies (tlsSource 'files', issue #51); the catch-all bellhop-tls-default is
  // reported as part of 'tls-connection', never on its own.
  object: 'route' | 'tls-policy' | 'tls-files' | 'tls-connection';
  hostnames: string[];
  // add/replace of a route only: its preview details.
  route?: ProxyRoute;
  // add/replace of 'tls-files' only: the certificate path it loads.
  certificatePath?: string;
}

export interface CaddyConfigPlan {
  // The complete configuration to write, or null when it would equal the
  // current one (nothing to write).
  config: CaddyConfigObject | null;
  changes: CaddyChange[];
  conflicts: CaddyConflict[];
  // Every Bellhop object in the planned configuration, in write order --
  // what the preview prints.
  bellhopObjects: Array<CaddyRoute | CaddyTlsPolicy | CaddyLoadFile | CaddyConnectionPolicy>;
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

// Add, replace, or remove: how one Bellhop object (or, for connection
// policies, one group of them) changed between the live and the planned
// configuration. undefined when it didn't.
function changeKind(before: unknown, after: unknown): CaddyChange['kind'] | undefined {
  if (after !== undefined && before === undefined) return 'add';
  if (after === undefined && before !== undefined) return 'remove';
  if (after !== undefined && canonicalJson(before) !== canonicalJson(after)) return 'replace';
  return undefined;
}

function sniOf(policy: CaddyConnectionPolicy | undefined): string[] {
  const sni = (policy?.match as { sni?: unknown } | undefined)?.sni;
  return Array.isArray(sni) ? (sni as string[]) : [];
}

// Which kinds of Bellhop object sit in a different place in `after` than in
// `before`, for a plan whose objects are all unchanged but whose
// configuration still differs (final review F4): routes, connection
// policies (any server -- a stale one on a non-target server moving back
// counts), the automation policy, or the load_files entry. Compares each
// container as a whole, since with no listed change the only difference
// left is position. Falls back to 'route' -- the one move that existed
// before issue #51 -- if nothing narrower explains the difference.
function movedObjects(before: CaddyConfigObject, after: CaddyConfigObject): CaddyChange['object'][] {
  const differs = (a: unknown, b: unknown) => canonicalJson(a ?? null) !== canonicalJson(b ?? null);
  const serversBefore = before.apps?.http?.servers ?? {};
  const serversAfter = after.apps?.http?.servers ?? {};
  const names = [...new Set([...Object.keys(serversBefore), ...Object.keys(serversAfter)])];
  const moved: CaddyChange['object'][] = [];
  if (names.some((n) => differs(serversBefore[n]?.routes, serversAfter[n]?.routes))) moved.push('route');
  if (differs(before.apps?.tls?.automation?.policies, after.apps?.tls?.automation?.policies)) moved.push('tls-policy');
  if (differs(before.apps?.tls?.certificates?.load_files, after.apps?.tls?.certificates?.load_files)) {
    moved.push('tls-files');
  }
  if (names.some((n) => differs(serversBefore[n]?.tls_connection_policies, serversAfter[n]?.tls_connection_policies))) {
    moved.push('tls-connection');
  }
  return moved.length > 0 ? moved : ['route'];
}

// Reconciles the desired routes against the live configuration (research
// R5/R6, issue #51 research R3/R4): strips every Bellhop object, leaves out
// routes whose hostnames an untagged object already claims (conflicts),
// prepends the rest -- routes to the HTTPS server, and the active TLS source's
// objects to their own lists (the automation policy to the automation
// policies, the load_files entry to load_files, the connection policies to
// that same HTTPS server) -- prunes any container a removed Bellhop object
// leaves empty, and reports what changed. Switching TLS sources is just this
// rebuild: every bellhop-tls* object is stripped and the current source's
// added back. The input is never mutated.
export function planCaddyConfig(
  current: CaddyConfig,
  routes: ProxyRoute[],
  ctx: ProxyContext,
  host: string
): CaddyConfigPlan {
  const config: CaddyConfigObject = current === null ? {} : (JSON.parse(JSON.stringify(current)) as CaddyConfigObject);
  const servers: Record<string, CaddyServer> = config.apps?.http?.servers ?? {};
  const policies: CaddyTlsPolicy[] = config.apps?.tls?.automation?.policies ?? [];
  const loadFiles: CaddyLoadFile[] = config.apps?.tls?.certificates?.load_files ?? [];

  // Existing Bellhop objects, for change detection.
  const existingRoutes = new Map<string, CaddyRoute>();
  const existingConnections: CaddyConnectionPolicy[] = [];
  for (const server of Object.values(servers)) {
    for (const r of server.routes ?? []) {
      // isBellhopObject has just checked that @id is a string.
      if (isBellhopObject(r)) existingRoutes.set(r['@id']!, r);
    }
    existingConnections.push(...(server.tls_connection_policies ?? []).filter(isBellhopObject));
  }
  const existingPolicy = policies.find(isBellhopObject);
  const existingLoadFile = loadFiles.find(isBellhopObject);

  // Conflicts: an untagged route (any server) naming the hostname exactly,
  // case-insensitively -- and an untagged automation policy doing the same,
  // but only under a TLS source where Bellhop writes an automation policy of
  // its own for it to collide with ('acme-dns'/'internal'). Under
  // 'acme-http' or 'files' an operator policy naming a Bellhop host is meant
  // to apply (research R4). Untagged load_files entries and connection
  // policies never claim: Bellhop's SNI policy is prepended, so it matches
  // first. Wildcards never match here. Throws for 'external' even with no
  // routes, so the backstop never depends on the inventory's contents.
  const writesPolicy = writesAutomationPolicy(ctx.tlsSource);
  const claims = new Map<string, Omit<CaddyConflict, 'hostname' | 'owner'>>();
  for (const [name, server] of Object.entries(servers)) {
    for (const r of server.routes ?? []) {
      if (isBellhopObject(r)) continue;
      for (const h of routeHosts(r)) {
        if (!claims.has(h.toLowerCase())) claims.set(h.toLowerCase(), { claimedBy: 'route', server: name });
      }
    }
  }
  for (const p of writesPolicy ? policies : []) {
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
  // No kept route means no TLS objects either, under any source -- an
  // empty-subjects policy or empty-SNI connection policy would match every
  // hostname.
  const desiredTls: CaddyTlsObjects =
    kept.length > 0 ? renderTlsObjects(kept.flatMap((r) => r.hostnames), ctx) : {};
  const desiredPolicy = desiredTls.policy;
  const desiredLoadFile = desiredTls.loadFile;
  // Filled in below once the target server is known: whether the catch-all
  // is needed depends on what that server already holds.
  const desiredConnections: CaddyConnectionPolicy[] = [];

  // Strip every Bellhop object. A server whose connection policies were
  // all Bellhop's loses the key entirely rather than keeping `[]`.
  for (const server of Object.values(servers)) {
    if (server.routes) server.routes = server.routes.filter((r) => !isBellhopObject(r));
    if (server.tls_connection_policies?.some(isBellhopObject)) {
      const rest = server.tls_connection_policies.filter((p) => !isBellhopObject(p));
      if (rest.length > 0) server.tls_connection_policies = rest;
      else delete server.tls_connection_policies;
    }
  }
  const operatorPolicies = policies.filter((p) => !isBellhopObject(p));
  const operatorLoadFiles = loadFiles.filter((f) => !isBellhopObject(f));

  // Prepend the desired objects.
  if (desiredRoutes.length > 0) {
    config.apps ??= {};
    config.apps.http ??= {};
    config.apps.http.servers ??= servers;
    const target = targetServer(config.apps.http.servers, host);
    const server = config.apps.http.servers[target];
    server.routes = [...desiredRoutes, ...(server.routes ?? [])];
    // Connection policies belong on the server the routes are on (research
    // R3). Bellhop's SNI policy goes first so it wins first-match; the
    // catch-all goes last, and only when the operator hasn't already got
    // one (an untagged policy with no match) -- two would be redundant.
    if (desiredTls.connectionPolicy) {
      const operatorConnections = server.tls_connection_policies ?? [];
      const hasCatchAll = operatorConnections.some((p) => p.match === undefined);
      desiredConnections.push(desiredTls.connectionPolicy);
      if (!hasCatchAll) desiredConnections.push(renderDefaultConnectionPolicy());
      server.tls_connection_policies = [desiredTls.connectionPolicy, ...operatorConnections, ...desiredConnections.slice(1)];
    }
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
  }
  const newLoadFiles = desiredLoadFile ? [desiredLoadFile, ...operatorLoadFiles] : operatorLoadFiles;
  if (newLoadFiles.length > 0) {
    config.apps ??= {};
    config.apps.tls ??= {};
    config.apps.tls.certificates ??= {};
    config.apps.tls.certificates.load_files = newLoadFiles;
  } else if (existingLoadFile && config.apps?.tls?.certificates) {
    // Same pruning as the policy above, for the certificates container.
    delete config.apps.tls.certificates.load_files;
    if (Object.keys(config.apps.tls.certificates).length === 0) delete config.apps.tls.certificates;
  }
  if ((existingPolicy || existingLoadFile) && config.apps?.tls && Object.keys(config.apps.tls).length === 0) {
    delete config.apps.tls;
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
  const policyChange = changeKind(existingPolicy, desiredPolicy);
  if (policyChange) {
    changes.push({ kind: policyChange, object: 'tls-policy', hostnames: (desiredPolicy ?? existingPolicy)?.subjects ?? [] });
  }
  const filesChange = changeKind(existingLoadFile, desiredLoadFile);
  if (filesChange) {
    changes.push({
      kind: filesChange,
      object: 'tls-files',
      hostnames: [],
      ...(desiredLoadFile?.certificate !== undefined ? { certificatePath: desiredLoadFile.certificate } : {}),
    });
  }
  // The connection policies change as one group, the catch-all included.
  const connectionChange = changeKind(
    existingConnections.length > 0 ? existingConnections : undefined,
    desiredConnections.length > 0 ? desiredConnections : undefined
  );
  if (connectionChange) {
    changes.push({
      kind: connectionChange,
      object: 'tls-connection',
      hostnames: sniOf(desiredTls.connectionPolicy ?? existingConnections.find((p) => p.match !== undefined)),
    });
  }

  const changed = canonicalJson(config) !== canonicalJson(current ?? {});
  if (changed && changes.length === 0) {
    // Same objects, different position (e.g. an operator moved a Bellhop
    // route behind their own, or a connection policy/load_files entry
    // behind theirs) -- still a write, so still a listed change, one per
    // kind of object that actually moved so the preview names the right one.
    changes.push(...movedObjects(current ?? {}, config).map((object) => ({ kind: 'reorder' as const, object, hostnames: [] })));
  }

  return {
    config: changed ? config : null,
    changes,
    conflicts,
    bellhopObjects: [
      ...desiredRoutes,
      ...(desiredPolicy ? [desiredPolicy] : []),
      ...(desiredLoadFile ? [desiredLoadFile] : []),
      ...desiredConnections,
    ],
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

// The parenthesised name of a moved TLS object in the preview's move line.
const MOVED_TLS_LABEL: Record<Exclude<CaddyChange['object'], 'route'>, string> = {
  'tls-policy': 'automation policy',
  'tls-files': 'certificate files',
  'tls-connection': 'connection policies',
};

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
    if (change.kind === 'reorder') {
      // Checked before the per-object lines below, which describe an
      // add/replace/remove, not a move.
      lines.push(
        change.object === 'route'
          ? `${symbol} move Bellhop routes ahead of hand-authored routes`
          : `${symbol} move Bellhop TLS objects ahead of hand-authored ones (${MOVED_TLS_LABEL[change.object]})`
      );
    } else if (change.object === 'tls-policy') {
      lines.push(
        change.kind === 'remove' ? `${symbol} tls policy` : `${symbol} tls policy: ${change.hostnames.length} hostnames`
      );
    } else if (change.object === 'tls-files') {
      lines.push(
        change.kind === 'remove' ? `${symbol} tls certificate files` : `${symbol} tls certificate files: ${change.certificatePath}`
      );
    } else if (change.object === 'tls-connection') {
      lines.push(
        change.kind === 'remove'
          ? `${symbol} tls connection policy`
          : `${symbol} tls connection policy: ${change.hostnames.length} hostnames`
      );
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
