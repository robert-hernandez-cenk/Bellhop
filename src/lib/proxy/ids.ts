// Dependency-free on purpose: src/lib/proxy/driver.ts, src/lib/proxy/
// index.ts's driver registry, and src/lib/inventory.ts's proxyDriver enum
// all need these ids, and none should have to import another to get them.
// 'caddy', 'nginx' (issue #30), 'haproxy' (issue #32) and 'traefik' (issue
// #35) are the file-configured drivers that ship today -- haproxy owns two
// files, a backends file and a hostname-to-backend map; traefik owns one
// file-provider file Traefik hot-reloads; 'nginx-proxy-manager' (issue #31)
// and 'caddy-api' (issue #26) are REST-managed drivers with no config file
// of their own; 'none' (issue #33) is a real registered driver too -- it
// means Bellhop manages no reverse proxy, not that no proxy exists in front
// of the deployment. A future driver adds its id here.
export const PROXY_DRIVER_IDS = ['caddy', 'nginx', 'nginx-proxy-manager', 'haproxy', 'traefik', 'none', 'caddy-api'] as const;
export type ProxyDriverId = (typeof PROXY_DRIVER_IDS)[number];

// The id of the driver that means "Bellhop manages no reverse proxy" --
// managesProxy() in ./driver.ts compares against this, and nothing else
// should compare against the bare literal.
export const NO_PROXY_DRIVER_ID: ProxyDriverId = 'none';

// The four ways the two Caddy drivers (caddy, caddy-api) can obtain a
// certificate for a site (issue #51) -- inert for every other driver, which
// either always obtains its own certificate one fixed way or shares
// ctx.tls/proxyCertResolver instead. Lives here, alongside PROXY_DRIVER_IDS,
// for the same reason: src/lib/inventory.ts's SettingsSchema (the
// proxyCaddyTls enum) and src/lib/proxy/routes.ts's ProxyContext both need
// this type/list without importing each other or proxy/index.ts's driver
// registry.
//   'cloudflare'  -- DNS-01 via Cloudflare (unset also means this; the
//                    original, only behavior before issue #51)
//   'letsencrypt' -- a public Let's Encrypt challenge, no DNS provider
//   'internal'    -- Caddy's own internal CA (self-signed, no public CA)
//   'files'       -- a shared certificate/key file pair, the same shape the
//                    nginx driver's proxyTlsCertificate/proxyTlsKey already
//                    use
export const CADDY_TLS_MODES = ['cloudflare', 'letsencrypt', 'internal', 'files'] as const;
export type CaddyTlsMode = (typeof CADDY_TLS_MODES)[number];

// The proxy driver an unset proxyDriver setting means -- getDriver() in
// ./index.ts and the legacy TLS conversion in ./legacy-tls.ts (issue #72)
// both resolve "the active driver" as inventory.proxyDriver ??
// DEFAULT_PROXY_DRIVER_ID. Lives here (re-exported by ./index.ts) so
// legacy-tls.ts can read it without importing the driver registry.
export const DEFAULT_PROXY_DRIVER_ID: ProxyDriverId = 'caddy';

// Where a deployment's TLS certificates come from (issue #72), independent
// of which proxy driver serves them -- each driver declares which of these
// it supports and which it uses when the tlsSource setting is unset
// (DriverCapabilities.tlsSources/defaultTlsSource, ./driver.ts). Lives here
// for the same dependency-free reason as PROXY_DRIVER_IDS: SettingsSchema
// (src/lib/inventory.ts) and ProxyContext (./routes.ts) both need the list.
//   'acme-dns'  -- the proxy obtains certificates itself over ACME DNS-01
//                  (provider chosen by acmeDnsProvider)
//   'acme-http' -- the proxy obtains certificates itself over a public ACME
//                  HTTP challenge, no DNS provider
//   'internal'  -- the proxy's own internal CA (self-signed, no public CA)
//   'files'     -- a shared certificate/key file pair
//                  (proxyTlsCertificate/proxyTlsKey)
//   'external'  -- something else issues and installs certificates; Bellhop
//                  renders no certificate configuration
export const TLS_SOURCES = ['acme-dns', 'acme-http', 'internal', 'files', 'external'] as const;
export type TlsSource = (typeof TLS_SOURCES)[number];

// The DNS providers 'acme-dns' can use (issue #72). Cloudflare is the only
// one Bellhop has credentials handling for today; a future provider adds its
// id here.
export const ACME_DNS_PROVIDERS = ['cloudflare'] as const;
export type AcmeDnsProvider = (typeof ACME_DNS_PROVIDERS)[number];

// inventory.acmeDnsProvider ?? DEFAULT_ACME_DNS_PROVIDER when unset -- the
// original, only provider before issue #72.
export const DEFAULT_ACME_DNS_PROVIDER: AcmeDnsProvider = 'cloudflare';
