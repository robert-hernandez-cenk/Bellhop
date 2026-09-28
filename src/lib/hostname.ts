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
