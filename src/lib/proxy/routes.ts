import type { Inventory } from '../inventory.ts';
import { effectiveAuth, isValidUnauthenticatedPath, UNAUTHENTICATED_PATH_MESSAGE } from '../inventory.ts';
import { publicHostname } from '../hostname.ts';
import { authentikConfig } from '../authentik-config.ts';

// Every site this toolkit's proxy fronts is reached externally over HTTPS on
// 443 -- not inventory-configurable, one operator, one deployment.
const EXTERNAL_PORT = 443;

export type PathPattern = { kind: 'exact'; path: string } | { kind: 'prefix'; path: string };

export type ProxyAuth =
  | { mode: 'ungated' }
  | { mode: 'oidc' }
  | { mode: 'forward'; exemptPaths: PathPattern[]; rawExemptPaths: string[] };

export interface ProxyRoute {
  owner: { type: 'host' | 'guest' | 'externalSite'; name: string };
  hostnames: string[];
  backend: { ip: string; port: number; insecureTls: boolean };
  auth: ProxyAuth;
}

export interface ProxyContext {
  outpost?: { ip: string; port: number };
  externalPort: number;
  // The certificate/key pair a file-configured driver that cannot obtain
  // its own per-site certificate (nginx, issue #30) writes into every
  // server block. Always present -- buildProxyContext can always derive it,
  // since domain is mandatory -- so a driver never has to handle "no
  // certificate". The Caddy driver ignores this field entirely: it obtains
  // its own per-site certificate via DNS-01 (see TLS_BLOCK in
  // src/lib/proxy/drivers/caddy.ts).
  tls: { certificatePath: string; keyPath: string };
}

// A stored unauthenticatedPaths string -> its parsed form (data-model.md
// "PathPattern"). Must start with '/'; '*' may appear only as the final
// character and only directly after a '/' (so "/api/*" and the bare "/*"
// are valid prefixes, but "/api*", "/a*b", and "/*/x" are not) -- the exact
// rule `isValidUnauthenticatedPath` (src/lib/inventory.ts) enforces, called
// here rather than re-implemented, so `UnauthenticatedPathSchema` and this
// function share one definition instead of two that could drift (issue #10,
// US4). Agreement is still exercised by a test that feeds every string the
// schema accepts through this function.
export function parsePathPattern(raw: string): PathPattern {
  if (!isValidUnauthenticatedPath(raw)) {
    throw new Error(`Invalid unauthenticatedPaths entry '${raw}' (${UNAUTHENTICATED_PATH_MESSAGE})`);
  }
  const starIndex = raw.indexOf('*');
  if (starIndex === -1) {
    return { kind: 'exact', path: raw };
  }
  return { kind: 'prefix', path: raw.slice(0, -1) };
}

// The fields buildRoutes reads off a host/guest/external-site entry --
// deliberately structural (not HostEntry|GuestEntry|ExternalSite directly)
// since all three satisfy it and buildRoutes never needs their other,
// entry-type-specific fields (vmid, ssh_target, ...).
interface ProxyCandidate {
  name: string;
  ip?: string;
  port?: number;
  subdomains?: string[];
  insecureBackendTls?: boolean;
  proxyManual?: boolean;
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
  unauthenticatedPaths?: string[];
}

// The one host/guest entry (if any) flagged `authentik: true` -- external
// sites are never eligible (ExternalSiteSchema has no such field: an
// external site can never itself be the Authentik instance).
function findAuthentikEntry(inventory: Inventory): { ip?: string } | undefined {
  return [...inventory.hosts, ...inventory.guests].find((e) => e.authentik);
}

type OwnerType = ProxyRoute['owner']['type'];

// Every host, guest, and external site, in the order hosts, guests,
// external sites (each already in loadInventory's sorted order).
function candidates(inventory: Inventory): { type: OwnerType; entry: ProxyCandidate }[] {
  return [
    ...inventory.hosts.map((entry) => ({ type: 'host' as const, entry })),
    ...inventory.guests.map((entry) => ({ type: 'guest' as const, entry })),
    ...(inventory.externalSites ?? []).map((entry) => ({ type: 'externalSite' as const, entry })),
  ];
}

// Only an entry with subdomains that isn't proxyManual gets a route.
function hasRoute(entry: ProxyCandidate): boolean {
  return !entry.proxyManual && (entry.subdomains ?? []).length > 0;
}

// One entry's route, from that entry alone -- it never looks at any other
// entry, so it cannot fail over one. Throws only for this entry's own
// invalid unauthenticatedPaths value.
function deriveRoute(type: OwnerType, entry: ProxyCandidate, inventory: Inventory): ProxyRoute {
  const mode = effectiveAuth(entry);
  const auth: ProxyAuth =
    mode === 'forward'
      ? {
          mode: 'forward',
          // parsePathPattern is called eagerly here (not deferred to a
          // driver) so a bad unauthenticatedPaths entry fails at
          // buildRoutes/sync-proxy time, naming both the entry and the raw
          // value -- parsePathPattern's own error has neither, since it
          // has no entry context of its own.
          exemptPaths: (entry.unauthenticatedPaths ?? []).map((raw) => {
            try {
              return parsePathPattern(raw);
            } catch {
              throw new Error(
                `Entry '${entry.name}' has an invalid unauthenticatedPaths pattern '${raw}': must be an exact path (/health) or a prefix ending in /* (/api/*)`
              );
            }
          }),
          // Copied, not the inventory's own array reference -- a caller
          // that mutates a route's rawExemptPaths (e.g. a driver sorting
          // it for rendering) must never reach back into the loaded
          // Inventory object.
          rawExemptPaths: [...(entry.unauthenticatedPaths ?? [])],
        }
      : mode === 'oidc'
        ? { mode: 'oidc' }
        : { mode: 'ungated' };

  return {
    owner: { type, name: entry.name },
    hostnames: (entry.subdomains ?? []).map((s) => publicHostname(s, inventory.domain)),
    backend: {
      // Non-null: validateInventory() already enforces that a non-manual
      // entry with subdomains has an ip -- entries reaching this point
      // are exactly those (hasRoute filters out the rest).
      ip: entry.ip!,
      port: entry.port ?? 80,
      insecureTls: entry.insecureBackendTls === true,
    },
    auth,
  };
}

// Derives one ProxyRoute per host/guest/external-site entry that has
// subdomains and isn't proxyManual, in the order hosts, guests, external
// sites (data-model.md "ProxyRoute"). Throws the missing-authentik message
// at the first forward-gated entry encountered with no authentik ip to
// address (contracts/driver-interface.md), before that entry's own
// exempt paths are parsed.
export function buildRoutes(inventory: Inventory): ProxyRoute[] {
  const authentikEntry = findAuthentikEntry(inventory);
  const routes: ProxyRoute[] = [];
  for (const { type, entry } of candidates(inventory)) {
    if (!hasRoute(entry)) continue;
    if (effectiveAuth(entry) === 'forward' && !authentikEntry?.ip) {
      throw new Error(
        `Entry '${entry.name}' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set`
      );
    }
    routes.push(deriveRoute(type, entry, inventory));
  }
  return routes;
}

// The one named entry's route, or undefined when it gets none (no
// subdomains, proxyManual, or no such entry). Built from that entry alone,
// so an unrelated entry's problem (a missing authentik ip, a bad exempt
// path) never makes it fail -- which is what commitGuestEdit's edit-time
// capability check needs. It skips buildRoutes's missing-authentik check:
// that is about where the outpost lives, not about the route's shape, and
// sync-proxy still reports it.
export function buildRouteForEntry(inventory: Inventory, owner: ProxyRoute['owner']): ProxyRoute | undefined {
  const found = candidates(inventory).find((c) => c.type === owner.type && c.entry.name === owner.name);
  if (!found || !hasRoute(found.entry)) return undefined;
  return deriveRoute(found.type, found.entry, inventory);
}

// The driver-agnostic context every route rendering needs alongside the
// routes themselves: where the Authentik embedded outpost lives (absent
// when there's no authentik:true entry with an ip -- a forward-gated route
// would already have thrown in buildRoutes before this matters), the fixed
// external port every site is reached on, and the shared TLS certificate/key
// pair (issue #30) -- proxyTlsCertificate/proxyTlsKey when set, else the
// domain-derived default path each falls back to independently.
export function buildProxyContext(inventory: Inventory): ProxyContext {
  const authentikEntry = findAuthentikEntry(inventory);
  const ctx: ProxyContext = {
    externalPort: EXTERNAL_PORT,
    tls: {
      certificatePath: inventory.proxyTlsCertificate ?? `/etc/letsencrypt/live/${inventory.domain}/fullchain.pem`,
      keyPath: inventory.proxyTlsKey ?? `/etc/letsencrypt/live/${inventory.domain}/privkey.pem`,
    },
  };
  if (authentikEntry?.ip) {
    ctx.outpost = { ip: authentikEntry.ip, port: authentikConfig().outpostPort };
  }
  return ctx;
}
