import type { GuestEntry, CustomScripts } from '../api/types';

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

// research R8: a custom-installed guest (appSource === 'custom') links
// straight to its ct/<slug>.sh in the configured repository/branch on
// GitHub instead of the plain community-scripts.org page, which only ever
// documents the upstream catalog and would 404/mislead for a fork-only app.
// Returns undefined for a custom guest when customScripts is null (the
// operator has since unset customScriptsRepo/customScriptsBranch) -- there
// is nothing to link to, rather than falling back to a wrong upstream URL.
export function communityScriptsUrl(guest: GuestEntry, customScripts?: CustomScripts | null): string | undefined {
  if (!guest.app) return undefined;
  if (guest.appSource === 'custom') {
    return customScripts ? `https://github.com/${customScripts.repo}/blob/${customScripts.branch}/ct/${guest.app}.sh` : undefined;
  }
  return `https://community-scripts.org/scripts/${guest.app}`;
}

// The label for communityScriptsUrl's link -- pulled out so
// AdvancedGuestModal.tsx and UpdatePage.tsx don't each hand-roll the same
// appSource === 'custom' ternary (review fix round 1, Unit E). Callers
// still guard rendering on communityScriptsUrl's own return value (this
// returns a label even when that URL is undefined, e.g. a custom guest with
// customScripts null).
export function communityScriptsLinkLabel(guest: GuestEntry, customScripts?: CustomScripts | null): string {
  return guest.appSource === 'custom' && customScripts
    ? `Open ${guest.app} in ${customScripts.repo}`
    : `Open ${guest.app} on community-scripts`;
}

// Direct ip:port link, bypassing Caddy/subdomains entirely -- https only for
// the two ports that are conventionally TLS (443, 8443), http otherwise.
export function ipUrl(guest: GuestEntry): string | undefined {
  if (!guest.ip) return undefined;
  const port = guest.port ?? 80;
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';
  return `${scheme}://${guest.ip}:${port}`;
}
