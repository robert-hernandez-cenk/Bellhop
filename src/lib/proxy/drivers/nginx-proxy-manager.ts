// The Nginx Proxy Manager driver (issue #31): the first managed driver with
// no configuration file. It reconciles one NPM proxy host per route over
// NPM's REST API (src/lib/npm-client.ts) instead of writing a file over
// SSH. Two halves: pure planning over (routes, NPM's hosts, NPM's
// certificates) -> NpmSyncPlan, and the driver object, which lists, plans,
// previews, and applies exactly the plan it previewed (never re-listing or
// re-diffing, so preview and apply cannot disagree). Behavior is pinned by
// specs/014-nginx-proxy-manager-driver/contracts/driver-and-client.md and
// research.md R4-R10.

import type { Inventory } from '../../inventory.ts';
import {
  buildNpmClient,
  type NpmCertificate,
  type NpmClient,
  type NpmProxyHost,
  type NpmProxyHostBody,
} from '../../npm-client.ts';
import type { DriverDeps, ProxyPlan, ReverseProxyDriver } from '../driver.ts';
import { renderServerBody } from '../nginx-locations.ts';
import type { ProxyContext, ProxyRoute } from '../routes.ts';

// The first line of every Bellhop proxy host's advanced_config (research
// R4). Visible in NPM's own UI, so the warning reaches whoever is about to
// edit the host; removing it hands the host back to the operator.
export const NPM_OWNERSHIP_MARKER = '# Managed by Bellhop sync-proxy. Do not edit: changes here are replaced on the next sync.';

export function isOwned(host: NpmProxyHost): boolean {
  return host.advanced_config.split(/\r?\n/, 1)[0] === NPM_OWNERSHIP_MARKER;
}

// -- Certificates (research R8) ----------------------------------------------

export type CertificateChoice = { kind: 'existing'; id: number; name: string } | { kind: 'request'; domainNames: string[] };

// Exact name, or `*.<rest>` covering exactly one extra label; case-insensitive.
export function certificateCovers(cert: NpmCertificate, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return cert.domain_names.some((raw) => {
    const name = raw.toLowerCase();
    if (name === host) return true;
    if (!name.startsWith('*.')) return false;
    const rest = name.slice(1); // ".example.com"
    if (!host.endsWith(rest)) return false;
    const label = host.slice(0, -rest.length);
    return label.length > 0 && !label.includes('.');
  });
}

// NPM's `expires_on` is UTC `YYYY-MM-DD HH:MM:SS`; anything else is NaN,
// which every comparison below treats as expired.
function expiryMs(cert: NpmCertificate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(cert.expires_on);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function qualifies(cert: NpmCertificate, hostnames: string[], now: Date): boolean {
  return expiryMs(cert) > now.getTime() && hostnames.every((h) => certificateCovers(cert, h));
}

// Keep the host's current certificate while it still qualifies; else the
// qualifying one expiring last (lowest id on a tie); else request one.
export function chooseCertificate(
  hostnames: string[],
  certificates: NpmCertificate[],
  currentId: number | undefined,
  now: Date
): CertificateChoice {
  const candidates = certificates.filter((c) => qualifies(c, hostnames, now));
  const current = candidates.find((c) => c.id === currentId);
  const best =
    current ??
    [...candidates].sort((a, b) => expiryMs(b) - expiryMs(a) || a.id - b.id)[0];
  return best ? { kind: 'existing', id: best.id, name: best.nice_name } : { kind: 'request', domainNames: [...hostnames] };
}

// -- Desired proxy host (research R9) ------------------------------------------

export type DesiredProxyHost = Omit<NpmProxyHostBody, 'certificate_id'> & { certificate: CertificateChoice };

export function desiredProxyHost(route: ProxyRoute, ctx: ProxyContext, certificate: CertificateChoice): DesiredProxyHost {
  const lines = renderServerBody(route, ctx, { host: '$http_host', connection: '$http_connection' });
  return {
    // Lower-cased: matching is case-insensitive, so what Bellhop sends (and
    // compares for drift) must be too, or a mixed-case subdomain would drift
    // on every sync.
    domain_names: route.hostnames.map((h) => h.toLowerCase()),
    forward_scheme: route.backend.insecureTls || route.backend.port === 443 ? 'https' : 'http',
    forward_host: route.backend.ip,
    forward_port: route.backend.port,
    ssl_forced: true,
    http2_support: true,
    allow_websocket_upgrade: true,
    block_exploits: false,
    caching_enabled: false,
    hsts_enabled: false,
    hsts_subdomains: false,
    trust_forwarded_proto: false,
    access_list_id: 0,
    advanced_config: [NPM_OWNERSHIP_MARKER, ...lines].join('\n'),
    enabled: true,
    locations: [],
    certificate,
  };
}

function toBody(desired: DesiredProxyHost, certificateId: number): NpmProxyHostBody {
  const { certificate: _certificate, ...rest } = desired;
  return { ...rest, certificate_id: certificateId };
}

// Compared in R9's order, so the preview's field list reads the same way
// every time.
const COMPARED_FIELDS = [
  'domain_names',
  'forward_scheme',
  'forward_host',
  'forward_port',
  'certificate_id',
  'ssl_forced',
  'http2_support',
  'allow_websocket_upgrade',
  'block_exploits',
  'caching_enabled',
  'hsts_enabled',
  'hsts_subdomains',
  'trust_forwarded_proto',
  'access_list_id',
  'advanced_config',
  'enabled',
  'locations',
] as const;

function changedFields(host: NpmProxyHost, desired: DesiredProxyHost): string[] {
  const current: Record<string, unknown> = {
    ...host,
    // desired.domain_names is already lower-cased; compare host names the same way.
    domain_names: host.domain_names.map((d) => d.toLowerCase()),
  };
  const wanted: Record<string, unknown> = {
    ...desired,
    // A requested certificate is by definition not the one the host has.
    certificate_id: desired.certificate.kind === 'existing' ? desired.certificate.id : undefined,
  };
  return COMPARED_FIELDS.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(wanted[field]));
}

// -- Plan (data-model.md NpmSyncPlan) -------------------------------------------

type Owner = ProxyRoute['owner'];

export type NpmRoutePlan =
  | { action: 'create'; owner: Owner; desired: DesiredProxyHost }
  // currentDomainNames: the host's names in NPM now (lower-cased), which
  // orderUpdates needs to run a name's release before its claim.
  | { action: 'update'; owner: Owner; hostId: number; desired: DesiredProxyHost; changed: string[]; currentDomainNames: string[] }
  | { action: 'unchanged'; owner: Owner; hostId: number; hostnames: string[] }
  | { action: 'conflict'; owner: Owner; canonical: string; hostnames: string[]; hostIds: number[] };

export interface NpmSyncPlan {
  routes: NpmRoutePlan[];
  deletes: { hostId: number; domainNames: string[] }[];
}

export function planNpmSync(
  routes: ProxyRoute[],
  ctx: ProxyContext,
  hosts: NpmProxyHost[],
  certificates: NpmCertificate[],
  now: Date = new Date()
): NpmSyncPlan {
  const owned = hosts.filter(isOwned);
  const unowned = hosts.filter((h) => !isOwned(h));
  const matched = new Set<number>();
  const planned: NpmRoutePlan[] = [];

  for (const route of routes) {
    const names = route.hostnames.map((h) => h.toLowerCase());

    // Rule 1: the owned host keyed by this route's canonical name. Marked
    // matched before the conflict check, so a conflicting route's own live
    // host is skipped along with the route rather than deleted by rule 2.
    const host = owned.find((h) => !matched.has(h.id) && (h.domain_names[0] ?? '').toLowerCase() === names[0]);
    if (host) matched.add(host.id);

    // Rule 3: an unowned host claiming any of this route's names blocks it.
    const claimants = unowned.filter((h) => h.domain_names.some((d) => names.includes(d.toLowerCase())));
    if (claimants.length > 0) {
      const claimed = route.hostnames.filter((h) =>
        claimants.some((c) => c.domain_names.some((d) => d.toLowerCase() === h.toLowerCase()))
      );
      planned.push({
        action: 'conflict',
        owner: route.owner,
        canonical: route.hostnames[0],
        hostnames: claimed,
        hostIds: claimants.map((c) => c.id).sort((a, b) => a - b),
      });
      continue;
    }

    const certificate = chooseCertificate(names, certificates, host?.certificate_id, now);
    const desired = desiredProxyHost(route, ctx, certificate);
    if (!host) {
      planned.push({ action: 'create', owner: route.owner, desired });
      continue;
    }
    const changed = changedFields(host, desired);
    planned.push(
      changed.length === 0
        ? { action: 'unchanged', owner: route.owner, hostId: host.id, hostnames: names }
        : {
            action: 'update',
            owner: route.owner,
            hostId: host.id,
            desired,
            changed,
            currentDomainNames: host.domain_names.map((d) => d.toLowerCase()),
          }
    );
  }

  // Rule 2: every owned host no route matched.
  const deletes = owned
    .filter((h) => !matched.has(h.id))
    .sort((a, b) => a.id - b.id)
    .map((h) => ({ hostId: h.id, domainNames: [...h.domain_names] }));

  return { routes: orderUpdates(planned), deletes };
}

type UpdatePlan = Extract<NpmRoutePlan, { action: 'update' }>;

// NPM rejects a write naming a hostname another proxy host still holds, so
// when an alias moves between two Bellhop hosts that are both being updated,
// the update releasing it must run before the update claiming it. Deletes
// already run first (research R10) and creates last; this orders the updates
// among themselves: update X must precede update Y when X currently holds a
// name Y wants. A stable topological sort -- among updates that are free to
// run, the earliest in route order goes next -- so unrelated updates keep
// route order. A genuine cycle (two hosts swapping aliases) cannot be
// ordered; its remaining updates keep route order and NPM's own "already in
// use" rejection fails the apply. The sorted updates go back into the slots
// updates held, so the preview (which lists plan.routes in order) shows them
// in exactly the order apply() runs them.
function orderUpdates(planned: NpmRoutePlan[]): NpmRoutePlan[] {
  const updates = planned.filter((r): r is UpdatePlan => r.action === 'update');
  const mustPrecede = (x: UpdatePlan, y: UpdatePlan): boolean =>
    x !== y && x.currentDomainNames.some((name) => y.desired.domain_names.includes(name));

  const remaining = [...updates];
  const ordered: UpdatePlan[] = [];
  while (remaining.length > 0) {
    const free = remaining.findIndex((y) => !remaining.some((x) => mustPrecede(x, y)));
    const next = remaining.splice(free === -1 ? 0 : free, 1)[0];
    ordered.push(next);
  }

  let i = 0;
  return planned.map((r) => (r.action === 'update' ? ordered[i++] : r));
}

// -- Preview ---------------------------------------------------------------------

function certificateLabel(certificate: CertificateChoice): string {
  return certificate.kind === 'existing'
    ? `#${certificate.id} ${certificate.name}`
    : `request Let's Encrypt for ${certificate.domainNames.join(', ')}`;
}

function hostIdList(ids: number[]): string {
  return ids.map((id) => `#${id}`).join(', ');
}

function routeLine(entry: NpmRoutePlan): string {
  switch (entry.action) {
    case 'create': {
      const d = entry.desired;
      return `  + create  ${d.domain_names.join(', ')} -> ${d.forward_scheme}://${d.forward_host}:${d.forward_port}  [certificate: ${certificateLabel(d.certificate)}]`;
    }
    case 'update': {
      const line = `  ~ update  ${entry.desired.domain_names[0]} (#${entry.hostId}): ${entry.changed.join(', ')}`;
      return entry.changed.includes('certificate_id') ? `${line}  [certificate: ${certificateLabel(entry.desired.certificate)}]` : line;
    }
    case 'unchanged':
      return `  = ok      ${entry.hostnames[0]} (#${entry.hostId})`;
    case 'conflict':
      return `  ! conflict ${entry.hostnames.join(', ')}: already claimed by proxy host ${hostIdList(entry.hostIds)} (not created by Bellhop), entry '${entry.owner.name}' -- delete or change it in Nginx Proxy Manager, or mark the entry proxyManual`;
  }
}

export function formatNpmPlan(plan: NpmSyncPlan, baseUrl: string): string {
  const changes = plan.routes.filter((r) => r.action === 'create' || r.action === 'update').length + plan.deletes.length;
  const conflicts = plan.routes.filter((r) => r.action === 'conflict').length;
  return [
    `Nginx Proxy Manager at ${baseUrl}`,
    ...plan.routes.map(routeLine),
    ...plan.deletes.map((d) => `  - delete  ${d.domainNames.join(', ')} (#${d.hostId})`),
    changes === 0 && conflicts === 0 ? 'No changes' : `${changes} change(s), ${conflicts} conflict(s)`,
  ].join('\n');
}

// -- Snapshot (contract "snapshot()") ---------------------------------------------

function indent(text: string): string[] {
  return text.split(/\r?\n/).map((line) => (line === '' ? '' : `    ${line}`));
}

export function formatNpmSnapshot(hosts: NpmProxyHost[], certificates: NpmCertificate[], baseUrl: string): string {
  const owned = hosts.filter(isOwned).sort((a, b) => a.id - b.id);
  const blocks = owned.map((h) => {
    const cert = certificates.find((c) => c.id === h.certificate_id);
    const certText = h.certificate_id === 0 ? 'none' : cert ? `#${cert.id} ${cert.nice_name}` : `#${h.certificate_id}`;
    const forwardAuth = /^\s*auth_request\s/m.test(h.advanced_config) ? 'yes' : 'no';
    const online = h.meta.nginx_online === false ? 'no' : 'yes';
    return [
      `#${h.id} ${h.domain_names.join(', ')} -> ${h.forward_scheme}://${h.forward_host}:${h.forward_port}`,
      `    certificate: ${certText}   forward-auth: ${forwardAuth}   online: ${online}`,
      ...indent(h.advanced_config),
    ].join('\n');
  });
  return [`Nginx Proxy Manager at ${baseUrl} -- ${owned.length} proxy host(s) managed by Bellhop`, ...blocks].join('\n\n');
}

// -- Driver -----------------------------------------------------------------------

interface NpmPayload {
  plan: NpmSyncPlan;
}

function payloadOf(plan: ProxyPlan): NpmPayload {
  const payload = plan.payload as Partial<NpmPayload> | null | undefined;
  if (!payload?.plan) {
    throw new Error('Nginx Proxy Manager apply() was given a plan not produced by its own plan()');
  }
  return payload as NpmPayload;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function certificateIdFor(client: NpmClient, desired: DesiredProxyHost): Promise<number> {
  const certificate = desired.certificate;
  if (certificate.kind === 'existing') return certificate.id;
  try {
    return (await client.requestCertificate(certificate.domainNames)).id;
  } catch (err) {
    throw new Error(`Could not get a Let's Encrypt certificate for ${desired.domain_names[0]}: ${errorText(err)}`);
  }
}

// Research R6: NPM accepts a host nginx then refuses to load, so every write
// is read back.
async function assertOnline(client: NpmClient, id: number, canonical: string): Promise<void> {
  const host = await client.getProxyHost(id);
  if (host.meta.nginx_online === false) {
    throw new Error(
      `Nginx Proxy Manager saved proxy host #${id} (${canonical}) but nginx rejected its configuration: ${host.meta.nginx_err ?? 'no error reported'} -- the site is offline until the next successful sync`
    );
  }
}

async function applyNpmPlan(client: NpmClient, plan: NpmSyncPlan): Promise<void> {
  // Deletes first, so a hostname moving between two Bellhop hosts is free
  // before the update/create that claims it (research R10). Updates run in
  // plan order, which orderUpdates already arranged so an update releasing
  // a name precedes the update claiming it.
  for (const d of plan.deletes) {
    await client.deleteProxyHost(d.hostId);
  }
  for (const entry of plan.routes) {
    if (entry.action !== 'update') continue;
    const certificateId = await certificateIdFor(client, entry.desired);
    await client.updateProxyHost(entry.hostId, toBody(entry.desired, certificateId));
    await assertOnline(client, entry.hostId, entry.desired.domain_names[0]);
  }
  for (const entry of plan.routes) {
    if (entry.action !== 'create') continue;
    const certificateId = await certificateIdFor(client, entry.desired);
    const { id } = await client.createProxyHost(toBody(entry.desired, certificateId));
    await assertOnline(client, id, entry.desired.domain_names[0]);
  }
  const conflicts = plan.routes.filter((r) => r.action === 'conflict');
  if (conflicts.length > 0) {
    const list = conflicts.map((c) => `${c.canonical} (entry '${c.owner.name}', ${hostIdList(c.hostIds)})`).join(', ');
    throw new Error(
      `${conflicts.length} route(s) skipped because a proxy host not created by Bellhop already claims their hostnames: ${list} -- delete or change those proxy hosts in Nginx Proxy Manager, or mark the entries proxyManual`
    );
  }
}

// `clientFor` is the seam tests use to inject a fake NpmClient; the
// registered driver below builds the real one from the environment.
export function createNpmDriver(opts: { clientFor: (inventory: Inventory) => NpmClient }): ReverseProxyDriver {
  return {
    id: 'nginx-proxy-manager',
    label: 'Nginx Proxy Manager',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: null,
    statusPage: null,

    async plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan> {
      const client = opts.clientFor(deps.inventory);
      const [hosts, certificates] = await Promise.all([client.listProxyHosts(), client.listCertificates()]);
      const plan = planNpmSync(routes, ctx, hosts, certificates);
      const payload: NpmPayload = { plan };
      return { preview: formatNpmPlan(plan, client.baseUrl), payload };
    },

    async apply(plan: ProxyPlan, deps: DriverDeps): Promise<void> {
      await applyNpmPlan(opts.clientFor(deps.inventory), payloadOf(plan).plan);
    },

    async snapshot(deps: DriverDeps): Promise<string> {
      const client = opts.clientFor(deps.inventory);
      const [hosts, certificates] = await Promise.all([client.listProxyHosts(), client.listCertificates()]);
      return formatNpmSnapshot(hosts, certificates, client.baseUrl);
    },
  };
}

export const nginxProxyManagerDriver = createNpmDriver({ clientFor: (inventory) => buildNpmClient(inventory) });
