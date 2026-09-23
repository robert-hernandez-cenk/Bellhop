import type { GuestEntry } from '../api/types';

// Numeric per-octet comparison so '192.168.1.2' sorts before '192.168.1.10'
// -- a plain string compare would put '.10' first. A missing ip sorts after
// every ip'd entry. Mirrors src/lib/inventory.ts's compareIp function, which
// is used the same way in sortInventoryForFile — keep both in sync if this
// changes.
export function compareIp(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Display-only ordering for the Guests table -- grouped by host, then by
// lxc/vm type, then ascending ip, ip-less guests last (tie-broken by name).
// Mirrors src/lib/inventory.ts's compareGuests/sortInventoryForFile, which
// duplicates this same comparator logic to keep bellhop.db's guests[]
// written in this same order on every save -- keep both in sync if this
// changes.
export function sortGuestsForDisplay(guests: GuestEntry[]): GuestEntry[] {
  return [...guests].sort((a, b) => {
    if (a.host !== b.host) return a.host < b.host ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    const ipCmp = compareIp(a.ip, b.ip);
    if (ipCmp !== 0) return ipCmp;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// Structural (not GuestEntry-specific) so it also works for a HostEntry --
// hosts can have subdomains too, they just never have an app.
export function caddyUrl(entry: { subdomains?: string[] }, domain: string): string | undefined {
  const subdomain = entry.subdomains?.[0];
  return subdomain ? `https://${subdomain}.${domain}` : undefined;
}

export function communityScriptsUrl(guest: GuestEntry): string | undefined {
  return guest.app ? `https://community-scripts.org/scripts/${guest.app}` : undefined;
}

// Direct ip:port link, bypassing Caddy/subdomains entirely -- https only for
// the two ports that are conventionally TLS (443, 8443), http otherwise.
export function ipUrl(guest: GuestEntry): string | undefined {
  if (!guest.ip) return undefined;
  const port = guest.port ?? 80;
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';
  return `${scheme}://${guest.ip}:${port}`;
}
