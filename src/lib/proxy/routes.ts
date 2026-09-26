import type { Inventory } from '../inventory.ts';
import { effectiveAuth } from '../inventory.ts';
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
}

// A stored unauthenticatedPaths string -> its parsed form (data-model.md
// "PathPattern"). Must start with '/'; '*' may appear only as the final
// character and only directly after a '/' (so "/api/*" and the bare "/*"
// are valid prefixes, but "/api*", "/a*b", and "/*/x" are not). The schema
// itself is tightened to match this exact rule in a later task (US4) --
// this function is the single source both agree with.
export function parsePathPattern(raw: string): PathPattern {
  const invalid = () =>
    new Error(`Invalid unauthenticatedPaths entry '${raw}' (must be an exact path (/health) or a prefix ending in /* (/api/*))`);
  if (!raw.startsWith('/')) {
    throw invalid();
  }
  const starIndex = raw.indexOf('*');
  if (starIndex === -1) {
    return { kind: 'exact', path: raw };
  }
  const isTrailingStarAfterSlash = starIndex === raw.length - 1 && raw[starIndex - 1] === '/';
  if (!isTrailingStarAfterSlash) {
    throw invalid();
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

// Derives one ProxyRoute per host/guest/external-site entry that has
// subdomains and isn't proxyManual, in the order hosts, guests, external
// sites (each already in loadInventory's sorted order) -- reproducing
// buildCaddyBlock's existing derivation rules (data-model.md "ProxyRoute"),
// just as a proxy-neutral data structure instead of rendered Caddyfile
// text. Throws the same missing-authentik message buildCaddyBlock does, at
// the same point (the first forward-gated entry encountered with no
// authentik ip to address), moved here per contracts/driver-interface.md.
export function buildRoutes(inventory: Inventory): ProxyRoute[] {
  const authentikEntry = findAuthentikEntry(inventory);
  const owned: { type: 'host' | 'guest' | 'externalSite'; entry: ProxyCandidate }[] = [
    ...inventory.hosts.map((entry) => ({ type: 'host' as const, entry })),
    ...inventory.guests.map((entry) => ({ type: 'guest' as const, entry })),
    ...(inventory.externalSites ?? []).map((entry) => ({ type: 'externalSite' as const, entry })),
  ];

  const routes: ProxyRoute[] = [];
  for (const { type, entry } of owned) {
    if (entry.proxyManual) continue;
    const subdomains = entry.subdomains ?? [];
    if (subdomains.length === 0) continue;

    const mode = effectiveAuth(entry);
    if (mode === 'forward' && !authentikEntry?.ip) {
      throw new Error(
        `Entry '${entry.name}' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set`
      );
    }

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

    routes.push({
      owner: { type, name: entry.name },
      hostnames: subdomains.map((s) => publicHostname(s, inventory.domain)),
      backend: {
        // Non-null: validateInventory() already enforces that a non-manual
        // entry with subdomains has an ip -- entries reaching this point
        // are exactly those (proxyManual/no-subdomains are skipped above).
        ip: entry.ip!,
        port: entry.port ?? 80,
        insecureTls: entry.insecureBackendTls === true,
      },
      auth,
    });
  }
  return routes;
}

// The driver-agnostic context every route rendering needs alongside the
// routes themselves: where the Authentik embedded outpost lives (absent
// when there's no authentik:true entry with an ip -- a forward-gated route
// would already have thrown in buildRoutes before this matters) and the
// fixed external port every site is reached on.
export function buildProxyContext(inventory: Inventory): ProxyContext {
  const authentikEntry = findAuthentikEntry(inventory);
  const ctx: ProxyContext = { externalPort: EXTERNAL_PORT };
  if (authentikEntry?.ip) {
    ctx.outpost = { ip: authentikEntry.ip, port: authentikConfig().outpostPort };
  }
  return ctx;
}
