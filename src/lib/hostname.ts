import type { Inventory } from './inventory.ts';
import { settingFix } from './settings-hint.ts';

// Builds a fully-qualified public hostname from a subdomain label and the
// operator's configured domain (inventory.domain). The single place this
// formatting happens -- src/lib/proxy/routes.ts's buildRoutes,
// sync-authentik.ts, and adopt-oidc-client.ts all call this instead of each
// interpolating `${sub}.${domain}` themselves, so they can never disagree
// about the format (issue #10, see
// specs/006-reverse-proxy-driver/contracts/driver-interface.md).
export function publicHostname(sub: string, domain: string): string {
  return `${sub}.${domain}`;
}

// The inventory domain for a caller that cannot proceed without one. Since
// issue #86 the domain is an optional setting (a fresh install has none
// until the setup walkthrough saves it), and validateInventory already
// refuses subdomains without it, so this only throws for a command run
// before the domain was ever set.
export function requireDomain(inventory: Pick<Inventory, 'domain'>): string {
  if (!inventory.domain) {
    throw new Error(`domain is not set -- ${settingFix('domain', '<domain>')}`);
  }
  return inventory.domain;
}
