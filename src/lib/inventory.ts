import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { logInfo, logWarn } from './log.ts';
import { ensureColumn, openDb } from './sqlite.ts';
import { parseGroupLadder } from './authentik-config.ts';
import { MovedSettingsSchema } from './settings-defs.ts';
import { SECRET_SETTINGS_TABLE_SQL, effectiveValue, invalidateConfigSnapshot } from './config.ts';
// From the dependency-free ids.ts, not proxy/index.ts's own registry
// module -- importing index.ts here would cycle back into this file.
import { PROXY_DRIVER_IDS, TLS_SOURCES, ACME_DNS_PROVIDERS, type ProxyDriverId, type TlsSource } from './proxy/ids.ts';
import { convertLegacyTlsSettings } from './proxy/legacy-tls.ts';

export const BridgeEntrySchema = z.object({
  name: z.string().min(1),
  alias: z.string().optional(),
  active: z.boolean().optional(),
});

export const StorageEntrySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  // Proxmox content types this storage is enabled for, e.g. "vztmpl"
  // (container templates), "rootdir"/"images" (container/VM disks),
  // "iso", "backup" -- what install-app's var_template_storage/
  // var_container_storage pick from.
  content: z.array(z.string()),
  active: z.boolean(),
  // Total capacity in bytes, as reported by Proxmox's own storage status --
  // omitted when Proxmox doesn't report one (e.g. an inactive storage), in
  // which case the dropdown falls back to showing the storage type instead.
  totalBytes: z.number().optional(),
});

export const NfsMountEntrySchema = z.object({
  name: z.string().min(1),
  export: z.string().min(1),
  mountPoint: z.string().min(1),
  active: z.boolean(),
});

// Absolute http(s) only -- used both by the zod schemas below (rejecting a
// relative path or a non-http(s) scheme at load time) and by
// parseOidcRedirectUris (rejecting the same thing at write time), so the
// two can never disagree about what counts as a valid callback URL.
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Shared by HostEntrySchema/GuestEntrySchema/ExternalSiteSchema's
// oidcRedirectUris -- one definition so all three enforce the exact same
// rule (issue #1, native OIDC gating).
const OidcRedirectUriSchema = z.string().refine(isAbsoluteHttpUrl, {
  message: 'must be an absolute http:// or https:// URL',
});

// Mobile-app hand-off addresses (issue #22, research R1) -- a custom scheme
// (app.example:///oauth-callback) is the whole point of this field, so
// unlike isAbsoluteHttpUrl above there's no scheme allow-list, only a fixed
// deny-list of schemes that are never a legitimate redirect target.
const DISALLOWED_MOBILE_REDIRECT_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript']);

// Shared by OidcMobileRedirectUriSchema below and parseOidcMobileRedirectUris
// (write time) so the two can never disagree -- same pattern as
// isAbsoluteHttpUrl/OidcRedirectUriSchema above.
function isValidMobileRedirectUri(value: string): boolean {
  // new URL() would silently percent-encode an embedded space rather than
  // reject it, so whitespace/control characters are rejected on the raw
  // string first, before it's ever handed to the URL parser.
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  return !DISALLOWED_MOBILE_REDIRECT_SCHEMES.has(scheme);
}

// Shared by HostEntrySchema/GuestEntrySchema/ExternalSiteSchema's
// oidcMobileRedirectUris -- one definition so all three enforce the exact
// same rule, mirroring OidcRedirectUriSchema above.
const OidcMobileRedirectUriSchema = z.string().refine(isValidMobileRedirectUri, {
  message: 'must be a valid URI with no whitespace/control characters and not a javascript:/data:/file:/vbscript: scheme',
});

// The exact message this schema, parseUnauthenticatedPaths below, and
// proxy/routes.ts's parsePathPattern all throw -- issue #10, US4: every
// proxy this toolkit could ever drive can express an exact path or a
// prefix, so a path exemption is restricted to those two forms rather than
// an arbitrary glob.
export const UNAUTHENTICATED_PATH_MESSAGE = 'must be an exact path (/health) or a prefix ending in /* (/api/*)';

// The single accept rule for a path exemption (data-model.md
// "PathPattern"): must start with '/'; '*' may appear only as the final
// character and only directly after '/'. Exported so proxy/routes.ts's
// parsePathPattern can call this directly instead of re-implementing the
// same check -- routes.ts already imports effectiveAuth from this file (the
// opposite direction would cycle, per this file's own
// PROXY_DRIVER_IDS-from-ids.ts-not-index.ts import above, but this direction
// is the one routes.ts already takes), so there is one definition, not two
// that could drift. Agreement is still exercised by a test that feeds every
// string this schema accepts through parsePathPattern.
export function isValidUnauthenticatedPath(raw: string): boolean {
  if (!raw.startsWith('/')) return false;
  const starIndex = raw.indexOf('*');
  if (starIndex === -1) return true;
  return starIndex === raw.length - 1 && raw[starIndex - 1] === '/';
}

// Shared by HostEntrySchema/GuestEntrySchema/ExternalSiteSchema's
// unauthenticatedPaths -- one definition so all three enforce the exact
// same rule rather than three separately-maintained copies (issue #10, US4).
export const UnauthenticatedPathSchema = z.string().refine(isValidUnauthenticatedPath, {
  message: UNAUTHENTICATED_PATH_MESSAGE,
});

export const MidSchemeSchema = z.object({
  vmidBase: z.number().int().min(0),
  // Dotted octets ending in "." -- e.g. "192.168.1." -- the prefix `mid`
  // gets appended to.
  ipPrefix: z.string().regex(
    /^(\d{1,3}\.){3}$/,
    'ipPrefix must be three dotted octets ending in "." (e.g. "192.168.1.")'
  ),
  // CIDR mask for the derived IP. Defaults to 16 (matching this toolkit's
  // long-standing hardcoded behavior) when omitted.
  cidrSuffix: z.number().int().min(0).max(32).optional(),
  gateway: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'gateway must be a dotted-quad IP'),
});

export const HostEntrySchema = z.object({
  name: z.string().min(1),
  ssh_target: z.string().min(1),
  ssh_user: z.string().min(1),
  // Non-default SSH port for this host. Omitted means 22 (ssh2's own
  // default -- connectConfig() in ssh-client.ts spreads `port` in only when
  // set rather than passing `?? 22`, so this file never holds a second copy
  // of that default). A separate field rather than a "host:port" ssh_target
  // because that form has no unambiguous parse for an IPv6 literal.
  ssh_port: z.number().int().min(1).max(65535).optional(),
  // Path to the private key to authenticate to this host with, overriding
  // the global ~/.ssh/id_ed25519 -> id_ecdsa -> id_rsa lookup. A bare
  // filename (no path separator) resolves against ~/.ssh/; a leading "~" is
  // expanded. Must be readable when set -- resolvePrivateKey() throws rather
  // than silently falling back, since a per-host override is an explicit
  // operator statement and quietly using a different key would surface much
  // later as an opaque sshd auth failure.
  ssh_identity_file: z.string().min(1).optional(),
  midScheme: MidSchemeSchema.optional(),
  proxy: z.boolean().optional(),
  subdomains: z.array(z.string()).optional(),
  // When true, this entry's proxy config is hand-authored elsewhere (e.g. a
  // block outside sync-proxy's managed markers) -- buildRoutes skips
  // generating a route for it entirely, even though its subdomains[]
  // still drives the Dashboard's service link.
  proxyManual: z.boolean().optional(),
  ip: z.string().optional(),
  port: z.number().optional(),
  // The reverse-proxied service's own backend speaks HTTPS with a
  // self-signed/otherwise-untrusted cert (e.g. the Proxmox web UI) -- tells
  // sync-proxy to skip TLS certificate verification for that backend (the
  // caddy driver emits `transport http { tls_insecure_skip_verify }`) so the
  // proxy doesn't refuse to connect to it.
  insecureBackendTls: z.boolean().optional(),
  // See ExternalSiteSchema's authGroup for what this does; also settable
  // on a host (e.g. the Proxmox web UI's own reverse-proxied subdomain).
  authGroup: z.string().min(1).optional(),
  // How this entry's gate is enforced when authGroup is set -- 'forward'
  // (forward-auth to the embedded outpost, the original behavior) or
  // 'oidc' (a native Authentik OpenID client, issue #1). Absent means
  // 'forward'. Meaningless without authGroup -- see effectiveAuth() below,
  // the single function every consumer (the proxy driver's route builder,
  // sync-authentik, the edit confirmation rule, the web UI) uses so they
  // can't disagree about which mode an entry is actually in.
  authMode: z.enum(['forward', 'oidc']).optional(),
  // Callback addresses Authentik's OpenID client redirects back to after
  // login, one per entry -- only meaningful when authMode is 'oidc'.
  // Deduplicated, order kept (parseOidcRedirectUris does the same at write
  // time; oidcConfigErrors requires at least one when effectiveAuth is
  // 'oidc' and the entry has subdomains).
  oidcRedirectUris: z.array(OidcRedirectUriSchema).optional(),
  // Mobile-app hand-off addresses -- same role as oidcRedirectUris, additive
  // to it (sync-authentik's clientRedirectUris merges both into one client
  // callback set) rather than a replacement, so a native app and a browser
  // login can share one entry. Inert unless authMode is 'oidc'; parsed at
  // write time by parseOidcMobileRedirectUris, and checked against
  // oidcRedirectUris for a duplicate by oidcConfigErrors below.
  oidcMobileRedirectUris: z.array(OidcMobileRedirectUriSchema).optional(),
  unauthenticatedPaths: z.array(UnauthenticatedPathSchema).optional(),
  // Marks this entry as the Authentik instance itself -- mirrors proxy:
  // true's "exactly one entry" role. sync-proxy resolves this entry's ip
  // to address the embedded outpost's forward_auth target.
  authentik: z.boolean().optional(),
  bridges: z.array(BridgeEntrySchema).optional(),
  // Fully refreshed by sync-inventory from Proxmox's own
  // /nodes/<node>/storage data, never hand-edited -- same treatment as
  // bridges[].
  storages: z.array(StorageEntrySchema).optional(),
  // Fully refreshed by sync-inventory from the host's own /etc/fstab, never
  // hand-edited -- same treatment as bridges[]/storages[]. Covers NFS shares
  // (nas-media, nas-immich) that were deliberately moved off Proxmox-managed
  // storage onto plain fstab mounts, because Proxmox's `nfs:` storage type
  // kept recreating a junk content-type directory at the share root.
  nfsMounts: z.array(NfsMountEntrySchema).optional(),
});

// The web-UI actor (issue #58) who triggered the create-lxc/create-vm/
// install-app/deploy-vpn-gateway apply that created this guest -- `uid` is
// the identity provider's stable user id (Authentik's X-authentik-uid),
// `username` its login name at the time the record was written. See
// GuestEntrySchema's `creator` comment below for who sets/preserves it.
export const GuestCreatorSchema = z.object({
  uid: z.string().min(1).optional(),
  username: z.string().min(1),
  // When this record was written (ISO-8601): the web apply's own clock, or
  // the creating job's start time for backfill-guest-creators. Only jobs
  // that started at or after it are lifted for the creator
  // (src/web/routes/jobs.ts's isJobVisible), so a guest re-created under a
  // reused name never exposes the old guest's job history. Absent means no
  // job lift at all (fail closed); guest access itself never reads it.
  since: z.string().min(1).optional(),
});
export type GuestCreator = z.infer<typeof GuestCreatorSchema>;

export const GuestEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['lxc', 'vm']),
  vmid: z.number().int().positive(),
  host: z.string().min(1),
  ip: z.string().optional(),
  port: z.number().optional(),
  subdomains: z.array(z.string()).optional(),
  // See HostEntrySchema's proxyManual for what this does.
  proxyManual: z.boolean().optional(),
  insecureBackendTls: z.boolean().optional(),
  authGroup: z.string().min(1).optional(),
  // See HostEntrySchema's authMode/oidcRedirectUris/oidcMobileRedirectUris
  // for what these do.
  authMode: z.enum(['forward', 'oidc']).optional(),
  oidcRedirectUris: z.array(OidcRedirectUriSchema).optional(),
  oidcMobileRedirectUris: z.array(OidcMobileRedirectUriSchema).optional(),
  unauthenticatedPaths: z.array(UnauthenticatedPathSchema).optional(),
  authentik: z.boolean().optional(),
  proxy: z.boolean().optional(),
  unprivileged: z.boolean().optional(),
  // The community-scripts slug this guest was installed from (e.g. "plex"),
  // set once by install-app's apply step -- preserved the same way `port` is:
  // upsertGuestEntry (src/web/routes/provisioning.ts) explicitly carries it
  // forward when a repeat apply for the same host+vmid doesn't provide a new
  // one, and sync-inventory's merge never touches it since it never includes
  // an `app` key at all. Drives the Dashboard's community-scripts quick-open
  // link; undefined for any guest not created via install-app.
  app: z.string().optional(),
  // Set only by the web/MCP install-app apply path (never the CLI, which
  // never touches inventory at all -- see the `app` comment above) when the
  // resolved AppSource.kind was 'custom' (src/lib/app-source.ts) -- i.e. this
  // guest's `app` slug was actually installed from the operator-configured
  // customScriptsRepo/customScriptsBranch, not from upstream
  // ProxmoxVE/ProxmoxVED. Preserved across a repeat apply for the same
  // host+vmid the same way `app` is (upsertGuestEntry in
  // src/operations/provisioning.ts), and never touched by sync-inventory's
  // merge. Drives the Dashboard/Update page's "open on GitHub" link instead
  // of the plain community-scripts.org one -- see research R8.
  appSource: z.literal('custom').optional(),
  // Marks this guest as a VPN gateway for a provider -- any number of
  // guests may share the same value (e.g. two 'nordvpn' gateways in
  // different regions). Set by deploy-vpn-gateway --apply on the guest it
  // creates.
  vpnGateway: z.enum(['nordvpn', 'pia']).optional(),
  // The *name* of the gateway guest (see vpnGateway above) this guest's
  // outbound traffic is currently routed through, or undefined if not
  // routed -- set/cleared by set-guest-vpn --apply.
  vpn: z.string().optional(),
  // The real (never impersonated) web-UI actor who created this guest
  // (issue #58), set only by create-lxc/create-vm/install-app/
  // deploy-vpn-gateway's apply step via deps.actor, or once by
  // backfill-guest-creators --apply for a guest that predates this field.
  // Absent for a guest created via the CLI, MCP, the synthetic local
  // operator, or one sync-inventory discovered on its own. Preserved
  // across sync-inventory/upsertGuestEntry merges and migrate-guest the
  // same way `app`/`port` are, and never changed by an ordinary guest
  // edit (the Dashboard PATCH route and MCP's edit_guest both ignore a
  // `creator` key in their input). Drives creator access in
  // src/lib/permissions.ts.
  creator: GuestCreatorSchema.optional(),
});

// A reverse-proxy target that isn't a Proxmox host or guest at all
// (a NAS, a non-Proxmox box on the LAN, ...) -- never an SSH/exec target,
// never touched by resolveTarget/runRemote/sync-inventory; the only command
// that ever reads this array is sync-proxy.
export const ExternalSiteSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  port: z.number().optional(),
  subdomains: z.array(z.string()).min(1),
  insecureBackendTls: z.boolean().optional(),
  // Names the Authentik group ladder rung that gates this entry's
  // subdomain(s) -- sync-authentik binds the matching Application to that
  // rung and every rung above it (see AUTHENTIK_GROUP_LADDER in
  // src/lib/authentik-config.ts), and sync-proxy emits the forward-auth
  // directive. Absent means ungated. A no-op on an entry with no subdomains
  // (no candidate to gate) in both commands. proxyManual only silences
  // sync-proxy (which skips generating any route for such an entry) --
  // sync-authentik still creates/maintains the Provider/Application
  // regardless of proxyManual, since a hand-authored proxy config block may
  // still want to route through it. Ladder membership is deliberately NOT
  // validated here or in validateInventory: sync-authentik reports an
  // off-ladder value instead, so an AUTHENTIK_GROUP_LADDER edit can never
  // make an already-saved inventory refuse to load.
  authGroup: z.string().min(1).optional(),
  // See HostEntrySchema's authMode/oidcRedirectUris/oidcMobileRedirectUris
  // for what these do.
  authMode: z.enum(['forward', 'oidc']).optional(),
  oidcRedirectUris: z.array(OidcRedirectUriSchema).optional(),
  oidcMobileRedirectUris: z.array(OidcMobileRedirectUriSchema).optional(),
  unauthenticatedPaths: z.array(UnauthenticatedPathSchema).optional(),
});

// Operator-specific scalars that used to be hardcoded literals (issue
// #124). All optional: a command that needs one throws a named error at
// the point of use rather than falling back to this repo author's own
// network, since a wrong IP is worse than a missing one for any other
// operator. Persisted as rows in the `meta` table alongside `domain`.
// `customScriptsRepo`/`customScriptsBranch` (issue #11) are a related pair
// naming a public GitHub repository laid out like ProxmoxVED (a fork
// branch) that install-app/update-app resolve apps from before falling
// back to the upstream community-scripts repos -- see src/lib/app-source.ts.
// Both unset means the feature is off. Unlike every other setting here,
// these two have a cross-field rule (set together or not at all), but that
// rule is deliberately NOT enforced by this schema: set-config writes one
// key at a time, so a schema-level both-or-neither check would make it
// impossible to ever set the first of the pair. The rule is instead
// enforced at the point of use, by customScriptSource() in
// src/lib/app-source.ts.
export const SettingsSchema = z.object({
  nfsServer: z.string().min(1).optional(),
  backupStorage: z.string().min(1).optional(),
  dnsServer: z.string().min(1).optional(),
  statusPagePath: z.string().regex(/^\//, 'must be an absolute path').optional(),
  // Which reverse-proxy driver src/lib/proxy/index.ts's getDriver() hands
  // back -- unset means the 'caddy' default (issue #10, issue #30).
  proxyDriver: z.enum(PROXY_DRIVER_IDS).optional(),
  // Overrides the active driver's own defaultConfigPath (issue #10) -- unset
  // means driverDeps() falls back to that default.
  proxyConfigPath: z.string().regex(/^\//, 'must be an absolute path').optional(),
  // Where certificates come from (issue #72), independent of the proxy
  // driver -- unset means the active driver's defaultTlsSource. Replaces the
  // Caddy-only proxyCaddyTls (issue #51) and the reserved
  // proxyCertResolver 'none'. Validated
  // only as an enum here; whether the active driver supports the chosen
  // source is checked when configuration is produced (checkTlsSource,
  // src/lib/proxy/tls.ts), so switching drivers never makes the database
  // unloadable.
  tlsSource: z.enum(TLS_SOURCES).optional(),
  // Which DNS provider the 'acme-dns' tlsSource uses (issue #72) -- unset
  // means DEFAULT_ACME_DNS_PROVIDER ('cloudflare').
  acmeDnsProvider: z.enum(ACME_DNS_PROVIDERS).optional(),
  // The certificate/key pair served under tlsSource 'files' (issues #30,
  // #72, research R1/R2) -- nginx's only source, and an option for Caddy
  // and Traefik. Each defaults independently -- unset means
  // /etc/letsencrypt/live/<domain>/fullchain.pem and .../privkey.pem
  // respectively (buildProxyContext, src/lib/proxy/routes.ts). Inert under
  // every other source.
  proxyTlsCertificate: z.string().regex(/^\//, 'must be an absolute path').optional(),
  proxyTlsKey: z.string().regex(/^\//, 'must be an absolute path').optional(),
  // The Traefik driver's own two settings (issue #35), both inert for every
  // other driver. proxyCertResolver names the ACME certificate resolver
  // every Bellhop-rendered router's tls.certResolver is set to -- unset
  // means 'cloudflare' (buildProxyContext, src/lib/proxy/routes.ts), a safe
  // default since research.md's live Traefik instance was configured with a
  // resolver of that name. The character class matches Traefik's own
  // resolver-name rules and can never break the rendered YAML or a route's
  // rule string, so there's nothing further to validate. Read only under
  // tlsSource 'acme-dns'/'acme-http'. No value is reserved (issue #72):
  // 'none' used to mean "no resolver" and is now an ordinary name --
  // tlsSource 'external' replaced it.
  proxyCertResolver: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, digits, - and _')
    .optional(),
  // proxyApiUrl points at Traefik's own read-only API (e.g.
  // http://127.0.0.1:8080) -- when set, the driver's validate step polls it
  // after writing the dynamic-configuration file to confirm Traefik loaded
  // the new version before declaring the apply a success (research.md
  // R2-R4); unset means no check at all. Parsed with `new URL` rather than
  // a regex so an operator typo (a stray space, no scheme) is caught the
  // same way a malformed URL always would be; the no-single-quote rule is
  // defensive only, since the value is embedded in a single-quoted shell
  // string that already escapes one (singleQuote, src/lib/proxy/
  // file-driver.ts).
  proxyApiUrl: z
    .string()
    .refine((value) => {
      if (value.includes("'")) return false;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'must be an http:// or https:// URL')
    .optional(),
  // GitHub "owner/repo" -- letters/digits/hyphens for the owner (no
  // leading/trailing hyphen), letters/digits/dots/hyphens/underscores for
  // the repo name (research R7).
  customScriptsRepo: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/, 'must be owner/repo')
    .optional(),
  // A git branch name -- the character class alone doesn't rule out every
  // invalid ref (git also forbids "..", a leading "/" or "-", and a
  // trailing "/" or ".lock"), so those are checked explicitly rather than
  // relied on to fall out of the regex.
  customScriptsBranch: z
    .string()
    .refine(
      (value) =>
        /^[A-Za-z0-9._/-]+$/.test(value) &&
        !value.includes('..') &&
        !value.startsWith('/') &&
        !value.startsWith('-') &&
        !value.endsWith('/') &&
        !value.endsWith('.lock'),
      'must be a valid git branch name'
    )
    .optional(),
  // The Authentik-backed Proxmox realm whose users get granted access to
  // the VMs/containers they create through this toolkit (issue #53) --
  // unset means the creator grant is off entirely (src/lib/pve-acl.ts's
  // grantCreatorAccess returns 'off'). Must start with a letter, matching
  // Proxmox's own realm-id rules, so it can never produce an invalid
  // `pveum realm` lookup.
  pveUserRealm: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9._-]+$/, 'must start with a letter and contain only letters, digits, ., - and _')
    .optional(),
  // The Proxmox role granted to a VM/container's creator on its own
  // /vms/<vmid> path (issue #53) -- unset means DEFAULT_CREATOR_ROLE
  // ('PVEVMAdmin', src/lib/pve-acl.ts). Matches Proxmox's own role-id
  // character class so it can never produce an invalid `pveum acl modify`
  // call.
  pveCreatorRole: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, 'must contain only letters, digits, ., - and _')
    .optional(),
  // The values issue #64 moved out of data/*.env files (Authentik, web UI
  // auth mode, Nginx Proxy Manager). Defined in the leaf settings-defs.ts
  // so src/lib/config.ts can validate them without importing this file
  // (research R2); spread here so they are ordinary meta rows, loaded,
  // validated and saved like every other setting. Secrets are not here --
  // they never ride along on an Inventory (research R1).
  ...MovedSettingsSchema.shape,
});

export type Settings = z.infer<typeof SettingsSchema>;
export const SETTINGS_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[];

// Sets one setting through a key only known at runtime. The cast is needed
// because proxyDriver's value is an enum literal, so Settings[key] is not
// one type TypeScript can narrow across every key. It is sound only for a
// value already checked against that key's schema: every caller either
// validates first (SettingsSchema.safeParse, or copying from an inventory
// that InventorySchema already accepted) or validates the result after
// (loadInventory's own InventorySchema.safeParse).
export function assignSetting(target: Partial<Settings>, key: keyof Settings, value: string | undefined): void {
  (target as Record<string, string | undefined>)[key] = value;
}

export const InventorySchema = z.object({
  domain: z.string().min(1),
  ...SettingsSchema.shape,
  hosts: z.array(HostEntrySchema),
  guests: z.array(GuestEntrySchema),
  externalSites: z.array(ExternalSiteSchema).optional(),
});

export type BridgeEntry = z.infer<typeof BridgeEntrySchema>;
export type StorageEntry = z.infer<typeof StorageEntrySchema>;
export type NfsMountEntry = z.infer<typeof NfsMountEntrySchema>;
export type MidScheme = z.infer<typeof MidSchemeSchema>;
export type HostEntry = z.infer<typeof HostEntrySchema>;
export type GuestEntry = z.infer<typeof GuestEntrySchema>;
export type ExternalSite = z.infer<typeof ExternalSiteSchema>;
export type Inventory = z.infer<typeof InventorySchema>;

// SECRET_SETTINGS_TABLE_SQL (issue #64) creates the secret_settings table,
// which loadInventory never reads and saveInventory never writes -- only
// src/lib/config.ts's writeSecret/clearSecret do (research R1).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hosts (
    name TEXT PRIMARY KEY,
    ssh_target TEXT NOT NULL,
    ssh_user TEXT NOT NULL,
    ssh_port INTEGER,
    ssh_identity_file TEXT,
    proxy INTEGER NOT NULL DEFAULT 0,
    proxy_manual INTEGER,
    ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
    bridges_json TEXT,
    storages_json TEXT,
    nfs_mounts_json TEXT,
    unauthenticated_paths_json TEXT,
    auth_mode TEXT,
    oidc_redirect_uris_json TEXT,
    oidc_mobile_redirect_uris_json TEXT
  );
  CREATE TABLE IF NOT EXISTS guests (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    host TEXT NOT NULL REFERENCES hosts(name),
    ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
    proxy INTEGER NOT NULL DEFAULT 0,
    proxy_manual INTEGER,
    unprivileged INTEGER, app TEXT,
    unauthenticated_paths_json TEXT,
    auth_mode TEXT,
    oidc_redirect_uris_json TEXT,
    oidc_mobile_redirect_uris_json TEXT,
    UNIQUE (host, vmid)
  );
  CREATE TABLE IF NOT EXISTS external_sites (
    name TEXT PRIMARY KEY,
    ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER,
    unauthenticated_paths_json TEXT,
    auth_mode TEXT,
    oidc_redirect_uris_json TEXT,
    oidc_mobile_redirect_uris_json TEXT
  );
  CREATE TABLE IF NOT EXISTS subdomains (
    subdomain TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS proxy_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_type TEXT NOT NULL, owner_name TEXT NOT NULL
  );
  ${SECRET_SETTINGS_TABLE_SQL}
`;

// One-time #158 migration: the requiresAuth boolean became authGroup, a
// group name. Every gated entry moves to the ladder's TOP rung -- the
// narrowest audience -- which fails closed: it's the deliberate, general
// intent of this migration on any database, not a value chosen to match
// this operator's Authentik state. For this operator's database that
// narrowest rung happens to be what the four gated Applications were
// already bound to in Authentik, so the first sync-authentik --apply after
// the migration is a no-op rather than a silent widening. On a different
// operator's database, landing on the narrowest rung generally *narrows*
// access relative to whatever the old requiresAuth boolean actually
// enforced -- re-tiering an individual app back to a broader rung
// afterward is expected, via the auth-group dropdown in the web UI.
// Dropping the old column is what makes this self-idempotent: once it is
// gone the PRAGMA guard below is false forever after, and a database
// created fresh by current code never had the column at all.
function migrateRequiresAuthToAuthGroup(db: Database.Database, table: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'requires_auth')) return;
  // The ladder comes from the database being opened (its stored
  // authentikGroupLadder setting, issue #64 FR-020), with the env var still
  // overriding it -- read off this handle through the shared precedence
  // rule rather than the config accessor, which would open a second
  // connection to a database that is mid-migration.
  const storedRow = db.prepare("SELECT value FROM meta WHERE key = 'authentikGroupLadder'").get() as
    | { value: string }
    | undefined;
  const ladder = parseGroupLadder(effectiveValue('authentikGroupLadder', storedRow?.value, process.env).value);
  const topRung = ladder[ladder.length - 1];
  // An empty ladder can only come from a deliberately all-separator
  // AUTHENTIK_GROUP_LADDER. Nothing could be gated under it anyway, so drop
  // the column and leave auth_group null rather than inventing a rung.
  if (topRung !== undefined) {
    const result = db
      .prepare(`UPDATE ${table} SET auth_group = ? WHERE requires_auth = 1 AND auth_group IS NULL`)
      .run(topRung);
    if (result.changes > 0) {
      logInfo(
        `Migrated ${result.changes} row(s) in '${table}' from requires_auth to auth_group='${topRung}' (#158, one-time, irreversible).`
      );
    }
  }
  db.exec(`ALTER TABLE ${table} DROP COLUMN requires_auth`);
}

// One-time #10 migration: the pre-refactor caddy-specific column/table names
// (`caddy`, `caddy_manual`, `caddy_owner`) become the proxy-neutral ones the
// reverse-proxy-driver refactor uses (`proxy`, `proxy_manual`, `proxy_owner`)
// -- same guarded, self-idempotent, log-only-when-something-changed pattern
// as #158's migrateRequiresAuthToAuthGroup below. Must run before the
// `ensureColumn(..., 'proxy_manual', ...)` calls in openInventoryDb: SCHEMA's
// own `CREATE TABLE IF NOT EXISTS proxy_owner` has already created an empty
// table by the time this runs, so `caddy_owner` -- never read by
// loadInventory, only written by saveInventory on every save -- is dropped
// rather than renamed onto it; the next save fills proxy_owner fresh.
// Renaming `caddy`/`caddy_manual` *after* ensureColumn had already added
// `proxy_manual` would collide with a duplicate-column error, hence the
// ordering requirement (research.md R7). Each column is checked
// independently (a database predating `caddy_manual` entirely just skips
// that rename and gets `proxy_manual` from ensureColumn below, same as any
// other never-had-this-column database). A database created fresh by
// current code has none of `caddy`/`caddy_manual`/`caddy_owner` at all
// (SCHEMA already names these `proxy`/`proxy_manual`/`proxy_owner`), so the
// guards are false from the start and nothing is logged, ever, for it.
function migrateCaddyToProxy(db: Database.Database): void {
  const tx = db.transaction(() => {
    const changed: string[] = [];
    for (const table of ['hosts', 'guests']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.some((c) => c.name === 'caddy')) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN caddy TO proxy`);
        changed.push(`${table}.caddy`);
      }
      if (cols.some((c) => c.name === 'caddy_manual')) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN caddy_manual TO proxy_manual`);
        changed.push(`${table}.caddy_manual`);
      }
    }
    const hasCaddyOwner = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'caddy_owner'")
      .get();
    if (hasCaddyOwner) {
      db.exec('DROP TABLE IF EXISTS caddy_owner');
      changed.push('caddy_owner');
    }
    if (changed.length > 0) {
      logInfo(`Migrated ${changed.join(', ')} from caddy to proxy naming (#10, one-time, irreversible).`);
    }
  });
  tx();
}

// One-time #69 migration: the web UI's auth modes became 'oidc' | 'none'.
// A stored 'authentik' meant "sign-in required", which is what 'oidc' means
// now; a stored 'auto' meant "authentik if the headers are there, else the
// dev fallback", which is simply the unset state now, so its row is deleted.
// 'oidc'/'none'/absent are left alone, which also makes it self-idempotent
// and silent on every open after the first.
function migrateWebUiAuthMode(db: Database.Database): void {
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'webUiAuthMode'").get() as { value: string } | undefined;
    if (row?.value === 'authentik') {
      db.prepare("UPDATE meta SET value = 'oidc' WHERE key = 'webUiAuthMode'").run();
      logInfo("Migrated webUiAuthMode from 'authentik' to 'oidc' (#69, one-time).");
    } else if (row?.value === 'auto') {
      db.prepare("DELETE FROM meta WHERE key = 'webUiAuthMode'").run();
      logInfo("Migrated webUiAuthMode 'auto' to unset (#69, one-time).");
    }
  });
  tx();
}

// One-time #72 migration: the pre-#72 TLS settings (the Caddy-only
// proxyCaddyTls meta row, and Traefik's reserved proxyCertResolver 'none')
// become the driver-neutral tlsSource setting, and the legacy rows are
// deleted. The conversion rules live in the pure convertLegacyTlsSettings
// (src/lib/proxy/legacy-tls.ts, data-model.md "Legacy conversion"); this
// reads the raw meta strings -- unvalidated, hence the pure function's
// own-key-only lookup -- and applies the result in one transaction. An
// already-set tlsSource is never overwritten. Self-idempotent like #10 and
// #158: once the legacy rows are gone the conversion has nothing to do and
// nothing is logged, and a database created fresh by current code never
// had them. Runs on every openInventoryDb caller (load and save alike),
// reading only this handle's meta table -- no config accessor, so it is
// safe mid-open and on paths that never load the inventory.
//
// A one-row guard query runs first and returns when no legacy row exists --
// every open after the first -- so the reads and the write lock below are
// only ever paid once. The transaction is IMMEDIATE: it reads and then
// writes, and a deferred one could hit SQLITE_BUSY_SNAPSHOT when two
// processes (the web service and a CLI command) open a legacy database at
// the same moment; taking the write lock up front makes the second wait
// for the first, then find nothing left to convert.
function migrateLegacyTlsSettings(db: Database.Database): void {
  const hasLegacyRow = db
    .prepare("SELECT 1 FROM meta WHERE key = 'proxyCaddyTls' OR (key = 'proxyCertResolver' AND value = 'none') LIMIT 1")
    .get();
  if (hasLegacyRow === undefined) return;
  const tx = db.transaction(() => {
    const read = (key: string): string | undefined =>
      (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const conversion = convertLegacyTlsSettings({
      proxyDriver: read('proxyDriver') as ProxyDriverId | undefined,
      proxyCaddyTls: read('proxyCaddyTls'),
      proxyCertResolver: read('proxyCertResolver'),
      tlsSource: read('tlsSource') as TlsSource | undefined,
    });
    if (conversion.description === undefined) return;
    if (conversion.tlsSource !== undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        'tlsSource',
        conversion.tlsSource
      );
    }
    for (const key of conversion.remove) db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    logInfo(`Migrated TLS settings to tlsSource (#72, one-time, irreversible): ${conversion.description}`);
  });
  tx.immediate();
}

function openInventoryDb(path: string): Database.Database {
  const db = openDb(path, SCHEMA);
  migrateCaddyToProxy(db);
  migrateWebUiAuthMode(db);
  // Order-independent of the column work below -- it touches only meta.
  migrateLegacyTlsSettings(db);
  ensureColumn(db, 'hosts', 'proxy_manual', 'proxy_manual INTEGER');
  ensureColumn(db, 'guests', 'proxy_manual', 'proxy_manual INTEGER');
  ensureColumn(db, 'guests', 'vpn_gateway', 'vpn_gateway TEXT');
  ensureColumn(db, 'guests', 'vpn', 'vpn TEXT');
  ensureColumn(db, 'hosts', 'auth_group', 'auth_group TEXT');
  ensureColumn(db, 'hosts', 'authentik', 'authentik INTEGER');
  ensureColumn(db, 'guests', 'auth_group', 'auth_group TEXT');
  ensureColumn(db, 'guests', 'authentik', 'authentik INTEGER');
  ensureColumn(db, 'external_sites', 'auth_group', 'auth_group TEXT');
  ensureColumn(db, 'hosts', 'mid_scheme_json', 'mid_scheme_json TEXT');
  ensureColumn(db, 'hosts', 'unauthenticated_paths_json', 'unauthenticated_paths_json TEXT');
  ensureColumn(db, 'guests', 'unauthenticated_paths_json', 'unauthenticated_paths_json TEXT');
  ensureColumn(db, 'external_sites', 'unauthenticated_paths_json', 'unauthenticated_paths_json TEXT');
  ensureColumn(db, 'hosts', 'ssh_port', 'ssh_port INTEGER');
  ensureColumn(db, 'hosts', 'ssh_identity_file', 'ssh_identity_file TEXT');
  ensureColumn(db, 'hosts', 'auth_mode', 'auth_mode TEXT');
  ensureColumn(db, 'hosts', 'oidc_redirect_uris_json', 'oidc_redirect_uris_json TEXT');
  ensureColumn(db, 'hosts', 'oidc_mobile_redirect_uris_json', 'oidc_mobile_redirect_uris_json TEXT');
  ensureColumn(db, 'guests', 'auth_mode', 'auth_mode TEXT');
  ensureColumn(db, 'guests', 'oidc_redirect_uris_json', 'oidc_redirect_uris_json TEXT');
  ensureColumn(db, 'guests', 'oidc_mobile_redirect_uris_json', 'oidc_mobile_redirect_uris_json TEXT');
  ensureColumn(db, 'external_sites', 'auth_mode', 'auth_mode TEXT');
  ensureColumn(db, 'external_sites', 'oidc_redirect_uris_json', 'oidc_redirect_uris_json TEXT');
  ensureColumn(db, 'external_sites', 'oidc_mobile_redirect_uris_json', 'oidc_mobile_redirect_uris_json TEXT');
  ensureColumn(db, 'guests', 'app_source', 'app_source TEXT');
  ensureColumn(db, 'guests', 'created_by_uid', 'created_by_uid TEXT');
  ensureColumn(db, 'guests', 'created_by_username', 'created_by_username TEXT');
  ensureColumn(db, 'guests', 'created_by_since', 'created_by_since TEXT');
  // Must run after the auth_group ensureColumn calls above -- it writes
  // into that column before dropping the one it read from.
  for (const table of ['hosts', 'guests', 'external_sites']) {
    migrateRequiresAuthToAuthGroup(db, table);
  }
  return db;
}

export function validateInventory(inv: Inventory): string[] {
  const errors: string[] = [];
  const hostNames = new Set(inv.hosts.map((h) => h.name));

  const proxyNames = [
    ...inv.hosts.filter((h) => h.proxy).map((h) => h.name),
    ...inv.guests.filter((g) => g.proxy).map((g) => g.name),
  ];
  if (proxyNames.length > 1) {
    errors.push(
      `Inventory validation: multiple entries flagged 'proxy: true' (only one is allowed): ${proxyNames.join(' ')}`
    );
  }

  const authentikNames = [
    ...inv.hosts.filter((h) => h.authentik).map((h) => h.name),
    ...inv.guests.filter((g) => g.authentik).map((g) => g.name),
  ];
  if (authentikNames.length > 1) {
    errors.push(
      `Inventory validation: multiple entries flagged 'authentik: true' (only one is allowed): ${authentikNames.join(' ')}`
    );
  }

  // Only forward-auth-gated entries route through the outpost (research
  // R10) -- an OIDC-gated entry needs no `authentik: true` entry at all,
  // so it's excluded from both checks below that assume one.
  const gatedNames = [
    ...inv.hosts.filter((h) => effectiveAuth(h) === 'forward').map((h) => h.name),
    ...inv.guests.filter((g) => effectiveAuth(g) === 'forward').map((g) => g.name),
    ...(inv.externalSites ?? []).filter((s) => effectiveAuth(s) === 'forward').map((s) => s.name),
  ];
  if (gatedNames.length > 0 && authentikNames.length === 0) {
    errors.push(
      `Inventory validation: ${gatedNames.map((n) => `'${n}'`).join(', ')} has an 'authGroup' set but no entry has 'authentik: true'`
    );
  }

  if (gatedNames.length > 0 && authentikNames.length > 0) {
    const authentikHasIp = [...inv.hosts, ...inv.guests].some((e) => e.authentik && e.ip);
    if (!authentikHasIp) {
      errors.push(
        `Inventory validation: ${gatedNames.join(', ')} has an 'authGroup' set but the 'authentik: true' entry has no 'ip' set`
      );
    }
  }

  for (const guest of inv.guests) {
    if (!hostNames.has(guest.host)) {
      errors.push(
        `Inventory validation: guest '${guest.name}' has host '${guest.host}' which does not match any entry in hosts[]`
      );
    }
  }

  const hostsWithMidScheme = inv.hosts.filter((h) => h.midScheme);
  const vmidBaseOwners = new Map<number, string[]>();
  const ipPrefixOwners = new Map<string, string[]>();
  for (const host of hostsWithMidScheme) {
    const scheme = host.midScheme!;
    vmidBaseOwners.set(scheme.vmidBase, [...(vmidBaseOwners.get(scheme.vmidBase) ?? []), host.name]);
    ipPrefixOwners.set(scheme.ipPrefix, [...(ipPrefixOwners.get(scheme.ipPrefix) ?? []), host.name]);
  }
  for (const [vmidBase, owners] of vmidBaseOwners) {
    if (owners.length > 1) {
      errors.push(
        `Inventory validation: hosts ${owners.map((n) => `'${n}'`).join(', ')} share the same midScheme.vmidBase (${vmidBase}) -- would derive colliding VMIDs`
      );
    }
  }
  for (const [ipPrefix, owners] of ipPrefixOwners) {
    if (owners.length > 1) {
      errors.push(
        `Inventory validation: hosts ${owners.map((n) => `'${n}'`).join(', ')} share the same midScheme.ipPrefix ('${ipPrefix}') -- would derive colliding IPs`
      );
    }
  }

  const allEntries: Array<{ name: string; subdomains?: string[]; ip?: string; proxyManual?: boolean }> = [
    ...inv.hosts,
    ...inv.guests,
    ...(inv.externalSites ?? []),
  ];
  for (const entry of allEntries) {
    // A proxyManual entry never produces a reverse_proxy target
    // (buildRoutes skips it outright), so it doesn't need an ip the way
    // a normally-managed entry with subdomains does.
    if (entry.proxyManual) continue;
    if (entry.subdomains && entry.subdomains.length > 0 && !entry.ip) {
      errors.push(
        `Inventory validation: entry '${entry.name}' has 'subdomains' set but no 'ip' (would produce a broken reverse_proxy target)`
      );
    }
  }

  // Two entries claiming the same subdomain would silently fight over the
  // one route sync-proxy generates for it -- catch that at validation time
  // rather than a confusing runtime proxy behavior.
  const subdomainOwners = new Map<string, string[]>();
  for (const entry of allEntries) {
    for (const subdomain of entry.subdomains ?? []) {
      const key = subdomain.toLowerCase();
      subdomainOwners.set(key, [...(subdomainOwners.get(key) ?? []), entry.name]);
    }
  }
  for (const [subdomain, owners] of subdomainOwners) {
    if (owners.length > 1) {
      errors.push(`Inventory validation: subdomain '${subdomain}' is claimed by multiple entries: ${owners.join(', ')}`);
    }
  }

  return errors;
}

// Semicolon-delimited free text (the web UI's Subdomains field) -> a
// deduplicated list, or undefined when empty so an entry with none doesn't
// grow a pointless `subdomains: []`.
export function parseSubdomains(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const list = Array.from(new Set(raw.split(';').map((s) => s.trim()).filter(Boolean)));
  return list.length > 0 ? list : undefined;
}

// The web UI's Port field (free text) -> a validated port number, or
// undefined when empty so an entry with none doesn't grow a pointless
// `port: 80` (buildRoutes's own `?? 80` default already covers that).
// Throws on non-empty-but-invalid input, unlike parseSubdomains, since a
// silently-dropped bad port is a worse experience than a clear rejection.
export function parsePort(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port '${raw}' (must be a whole number from 1 to 65535)`);
  }
  return port;
}

// The web UI's auth-tier dropdown -> a group name, or undefined for its "No
// authentication" option. Both null and '' clear the gate, matching the
// Settings page's own clear-a-value convention. Ladder membership is NOT
// checked here on purpose -- see ExternalSiteSchema's authGroup comment;
// the route layer checks it, so a bad AUTHENTIK_GROUP_LADDER can never make
// an already-saved inventory unloadable.
export function parseAuthGroup(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid authGroup (must be a group name, null, or an empty string)');
  const name = raw.trim();
  return name === '' ? undefined : name;
}

// Exactly `/outpost.goauthentik.io`, or anything under
// `/outpost.goauthentik.io/` (which covers the `/outpost.goauthentik.io/*`
// prefix form too). Every forward-gated route sends this namespace to the
// Authentik outpost regardless of any exemption (Caddy's
// `handle /outpost.goauthentik.io/*`; nginx skips such a pattern at render
// time, since its own exempt location would outrank the outpost's).
function isOutpostNamespacePath(pattern: string): boolean {
  return pattern === '/outpost.goauthentik.io' || pattern.startsWith('/outpost.goauthentik.io/');
}

// Semicolon-delimited free text (the web UI's Unauthenticated Paths field)
// -> a deduplicated list of proxy path-matcher globs, or undefined when
// empty so an entry with none doesn't grow a pointless
// `unauthenticatedPaths: []`. Throws on a non-empty pattern that isn't one
// of the two accepted forms (isValidUnauthenticatedPath -- the same rule
// UnauthenticatedPathSchema enforces), unlike parseSubdomains's silent-drop
// behavior -- a pattern that silently never matches as intended is a worse
// experience than a rejected save. The edit rule is deliberately stricter
// than the schema in one respect: a path in the Authentik outpost's own
// namespace (isOutpostNamespacePath) is rejected here but still loads from
// a saved inventory, so an entry saved before this rule existed never makes
// the inventory unloadable (the drivers already ignore such an exemption).
export function parseUnauthenticatedPaths(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const list = Array.from(new Set(raw.split(';').map((s) => s.trim()).filter(Boolean)));
  for (const pattern of list) {
    if (!isValidUnauthenticatedPath(pattern)) {
      throw new Error(`Invalid unauthenticated path '${pattern}' (${UNAUTHENTICATED_PATH_MESSAGE})`);
    }
    if (isOutpostNamespacePath(pattern)) {
      throw new Error(
        `Invalid unauthenticated path '${pattern}': paths under /outpost.goauthentik.io belong to the Authentik outpost ` +
          `and are always routed to it, so they can't be exempted -- remove this entry`
      );
    }
  }
  return list.length > 0 ? list : undefined;
}

// The single source of truth for whether/how an entry is gated -- every
// consumer (buildRoutes, sync-authentik, the edit confirmation rule,
// the web UI) calls this instead of re-deriving it from authGroup/authMode
// separately, so they cannot disagree (data-model.md "Derived state").
// authMode is meaningless without authGroup, so an unset authGroup is
// 'ungated' regardless of what authMode happens to hold.
export function effectiveAuth(entry: {
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
}): 'ungated' | 'forward' | 'oidc' {
  if (!entry.authGroup) return 'ungated';
  return entry.authMode === 'oidc' ? 'oidc' : 'forward';
}

// The web UI's Auth Mode dropdown -> a validated mode, or undefined for
// "use the default" (which effectiveAuth() treats the same as 'forward').
// null and '' both clear it, matching parseAuthGroup's own null/''-clears
// convention. An explicit 'forward' is returned verbatim rather than
// collapsed to undefined -- storing it is harmless, and it mirrors exactly
// what was submitted.
export function parseAuthMode(raw: unknown): 'forward' | 'oidc' | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (raw !== 'forward' && raw !== 'oidc') {
    throw new Error(`Invalid authMode '${raw}' (must be 'forward' or 'oidc')`);
  }
  return raw;
}

// Shared by parseOidcRedirectUris and parseOidcMobileRedirectUris, which
// differ only in their validator and error message: a ';'-joined string
// (the web UI's free-text field) or a typed array (CLI/MCP JSON) -> a
// deduplicated list in authored order, or undefined when empty. Throws on the
// first invalid entry rather than silently dropping it.
function parseUriList(raw: unknown, isValid: (uri: string) => boolean, invalidMessage: (uri: string) => string): string[] | undefined {
  let list: string[];
  if (Array.isArray(raw)) {
    list = raw.map((v) => String(v).trim()).filter(Boolean);
  } else if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    list = raw.split(';').map((s) => s.trim()).filter(Boolean);
  } else {
    return undefined;
  }
  const deduped = Array.from(new Set(list));
  for (const uri of deduped) {
    if (!isValid(uri)) throw new Error(invalidMessage(uri));
  }
  return deduped.length > 0 ? deduped : undefined;
}

// The web UI's Callback URLs field (semicolon-joined free text, matching
// parseSubdomains/parseUnauthenticatedPaths) or a typed array (CLI/MCP
// JSON) -> a deduplicated list of absolute http(s) URLs in authored order,
// or undefined when empty so an entry with none doesn't grow a pointless
// `oidcRedirectUris: []`. Throws on a non-http(s) entry, naming the bad
// URL -- same "reject rather than silently drop" precedent as
// parseUnauthenticatedPaths, since an OIDC client Authentik won't accept
// is worse than a rejected save.
export function parseOidcRedirectUris(raw: unknown): string[] | undefined {
  return parseUriList(raw, isAbsoluteHttpUrl, (url) => `Invalid redirect URI '${url}' (must be an absolute http:// or https:// URL)`);
}

// The web UI's mobile-redirect-URI field (semicolon-joined free text) or a
// typed array (CLI/MCP JSON) -> a deduplicated list of valid mobile hand-off
// URIs in authored order, or undefined when empty -- same input handling and
// same "reject rather than silently drop" precedent as parseOidcRedirectUris
// above, just against isValidMobileRedirectUri's broader (custom-scheme-
// friendly) rule instead of isAbsoluteHttpUrl's http(s)-only one.
export function parseOidcMobileRedirectUris(raw: unknown): string[] | undefined {
  return parseUriList(
    raw,
    isValidMobileRedirectUri,
    (uri) =>
      `Invalid mobile redirect URI '${uri}' (must be a valid URI with no whitespace/control characters and not a javascript:/data:/file:/vbscript: scheme)`
  );
}

// Write-level validation for an OIDC-gated entry (research R7): deliberately
// NOT part of validateInventory(), which runs on every load -- the same
// reasoning that kept ladder membership out of it (#158) applies here, so a
// hand edit to the database can never make the inventory refuse to load.
// Called from the write path (commitGuestEdit) instead; the sync's own skip
// report catches anything that reached the database another way.
// `checkCrossListDuplicates` is false when the edit changed neither URI list,
// so a duplicate already saved (a hand edit, or an older build) never blocks
// an unrelated later edit such as a port change.
export function oidcConfigErrors(
  entry: {
    authGroup?: string;
    authMode?: 'forward' | 'oidc';
    subdomains?: string[];
    oidcRedirectUris?: string[];
    oidcMobileRedirectUris?: string[];
  },
  { checkCrossListDuplicates = true }: { checkCrossListDuplicates?: boolean } = {}
): string[] {
  const errors: string[] = [];
  if (
    effectiveAuth(entry) === 'oidc' &&
    (entry.subdomains?.length ?? 0) > 0 &&
    (entry.oidcRedirectUris?.length ?? 0) === 0
  ) {
    errors.push('oidcRedirectUris: set at least one callback URL for an OIDC-gated entry');
  }
  // A URI listed in both is harmless to the sync (research R2 -- the client
  // callback set is deduplicated regardless, see sync-authentik's
  // clientRedirectUris), but almost certainly an authoring mistake, so it's
  // rejected at write time the same way an invalid URI itself is.
  if (!checkCrossListDuplicates) return errors;
  const webUris = new Set(entry.oidcRedirectUris ?? []);
  for (const uri of entry.oidcMobileRedirectUris ?? []) {
    if (webUris.has(uri)) {
      errors.push(`oidcMobileRedirectUris: '${uri}' is also a web callback URL; list it in only one`);
    }
  }
  return errors;
}

interface HostRow {
  name: string;
  ssh_target: string;
  ssh_user: string;
  ssh_port: number | null;
  ssh_identity_file: string | null;
  mid_scheme_json: string | null;
  proxy: number;
  proxy_manual: number | null;
  ip: string | null;
  port: number | null;
  insecure_backend_tls: number | null;
  auth_group: string | null;
  auth_mode: string | null;
  oidc_redirect_uris_json: string | null;
  oidc_mobile_redirect_uris_json: string | null;
  authentik: number | null;
  bridges_json: string | null;
  storages_json: string | null;
  nfs_mounts_json: string | null;
  unauthenticated_paths_json: string | null;
}

interface GuestRow {
  name: string;
  type: string;
  vmid: number;
  host: string;
  ip: string | null;
  port: number | null;
  insecure_backend_tls: number | null;
  auth_group: string | null;
  auth_mode: string | null;
  oidc_redirect_uris_json: string | null;
  oidc_mobile_redirect_uris_json: string | null;
  authentik: number | null;
  proxy: number;
  proxy_manual: number | null;
  unprivileged: number | null;
  app: string | null;
  app_source: string | null;
  vpn_gateway: string | null;
  vpn: string | null;
  created_by_uid: string | null;
  created_by_username: string | null;
  created_by_since: string | null;
  unauthenticated_paths_json: string | null;
}

interface ExternalSiteRow {
  name: string;
  ip: string;
  port: number | null;
  insecure_backend_tls: number | null;
  auth_group: string | null;
  auth_mode: string | null;
  oidc_redirect_uris_json: string | null;
  oidc_mobile_redirect_uris_json: string | null;
  unauthenticated_paths_json: string | null;
}

interface SubdomainRow {
  subdomain: string;
  owner_type: string;
  owner_name: string;
}

export function loadInventory(path: string): Inventory {
  const db = openInventoryDb(path);
  try {
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));
    const hostRows = db.prepare('SELECT * FROM hosts ORDER BY name').all() as HostRow[];
    const guestRows = db.prepare('SELECT * FROM guests ORDER BY host, name').all() as GuestRow[];
    const externalSiteRows = db.prepare('SELECT * FROM external_sites ORDER BY name').all() as ExternalSiteRow[];
    // ORDER BY rowid, not `subdomain` -- array order is operator-meaningful
    // (sync-proxy treats the first subdomain as an entry's canonical
    // hostname), and saveInventory always fully clears this table and
    // re-inserts every owner's subdomains in their original array order
    // within one transaction, so rowid order == insertion order == authored
    // order. Any future writer of this table (e.g. a one-off migration
    // script) MUST preserve plain array-order insertion too, or this
    // ordering guarantee silently breaks.
    const subdomainRows = db.prepare('SELECT * FROM subdomains ORDER BY rowid').all() as SubdomainRow[];

    const subdomainsFor = (ownerType: string, ownerName: string): string[] | undefined => {
      const list = subdomainRows.filter((s) => s.owner_type === ownerType && s.owner_name === ownerName).map((s) => s.subdomain);
      return list.length > 0 ? list : undefined;
    };

    const hosts = hostRows.map((row) => ({
      name: row.name,
      ssh_target: row.ssh_target,
      ssh_user: row.ssh_user,
      ssh_port: row.ssh_port ?? undefined,
      ssh_identity_file: row.ssh_identity_file ?? undefined,
      midScheme: row.mid_scheme_json ? JSON.parse(row.mid_scheme_json) : undefined,
      proxy: row.proxy ? true : undefined,
      proxyManual: row.proxy_manual ? true : undefined,
      subdomains: subdomainsFor('host', row.name),
      ip: row.ip ?? undefined,
      port: row.port ?? undefined,
      insecureBackendTls: row.insecure_backend_tls == null ? undefined : row.insecure_backend_tls ? true : false,
      authGroup: row.auth_group ?? undefined,
      authMode: (row.auth_mode ?? undefined) as 'forward' | 'oidc' | undefined,
      oidcRedirectUris: row.oidc_redirect_uris_json ? JSON.parse(row.oidc_redirect_uris_json) : undefined,
      oidcMobileRedirectUris: row.oidc_mobile_redirect_uris_json ? JSON.parse(row.oidc_mobile_redirect_uris_json) : undefined,
      authentik: row.authentik ? true : undefined,
      bridges: row.bridges_json ? JSON.parse(row.bridges_json) : undefined,
      storages: row.storages_json ? JSON.parse(row.storages_json) : undefined,
      nfsMounts: row.nfs_mounts_json ? JSON.parse(row.nfs_mounts_json) : undefined,
      unauthenticatedPaths: row.unauthenticated_paths_json ? JSON.parse(row.unauthenticated_paths_json) : undefined,
    }));

    const guests = guestRows.map((row) => ({
      name: row.name,
      type: row.type as 'lxc' | 'vm',
      vmid: row.vmid,
      host: row.host,
      ip: row.ip ?? undefined,
      port: row.port ?? undefined,
      subdomains: subdomainsFor('guest', row.name),
      insecureBackendTls: row.insecure_backend_tls == null ? undefined : row.insecure_backend_tls ? true : false,
      authGroup: row.auth_group ?? undefined,
      authMode: (row.auth_mode ?? undefined) as 'forward' | 'oidc' | undefined,
      oidcRedirectUris: row.oidc_redirect_uris_json ? JSON.parse(row.oidc_redirect_uris_json) : undefined,
      oidcMobileRedirectUris: row.oidc_mobile_redirect_uris_json ? JSON.parse(row.oidc_mobile_redirect_uris_json) : undefined,
      authentik: row.authentik ? true : undefined,
      proxy: row.proxy ? true : undefined,
      proxyManual: row.proxy_manual ? true : undefined,
      unprivileged: row.unprivileged === null ? undefined : !!row.unprivileged,
      app: row.app ?? undefined,
      appSource: (row.app_source ?? undefined) as 'custom' | undefined,
      vpnGateway: (row.vpn_gateway ?? undefined) as 'nordvpn' | 'pia' | undefined,
      vpn: row.vpn ?? undefined,
      // `creator` present iff created_by_username is non-null; `uid`/`since`
      // iff created_by_uid/created_by_since are non-null -- all conditional
      // spreads, not `... : undefined`, so a guest with no creator (or a
      // creator with no uid or since) round-trips without that key at all
      // rather than one set to `undefined`.
      ...(row.created_by_username
        ? {
            creator: {
              ...(row.created_by_uid ? { uid: row.created_by_uid } : {}),
              username: row.created_by_username,
              ...(row.created_by_since ? { since: row.created_by_since } : {}),
            },
          }
        : {}),
      unauthenticatedPaths: row.unauthenticated_paths_json ? JSON.parse(row.unauthenticated_paths_json) : undefined,
    }));

    const externalSites = externalSiteRows.map((row) => ({
      name: row.name,
      ip: row.ip,
      port: row.port ?? undefined,
      subdomains: subdomainsFor('external_site', row.name) ?? [],
      insecureBackendTls: row.insecure_backend_tls == null ? undefined : row.insecure_backend_tls ? true : false,
      authGroup: row.auth_group ?? undefined,
      authMode: (row.auth_mode ?? undefined) as 'forward' | 'oidc' | undefined,
      oidcRedirectUris: row.oidc_redirect_uris_json ? JSON.parse(row.oidc_redirect_uris_json) : undefined,
      oidcMobileRedirectUris: row.oidc_mobile_redirect_uris_json ? JSON.parse(row.oidc_mobile_redirect_uris_json) : undefined,
      unauthenticatedPaths: row.unauthenticated_paths_json ? JSON.parse(row.unauthenticated_paths_json) : undefined,
    }));

    const settings: Settings = {};
    for (const key of SETTINGS_KEYS) {
      const value = meta.get(key);
      if (value !== undefined) assignSetting(settings, key, value);
    }

    const assembled = sortInventoryForFile({
      domain: meta.get('domain') ?? '',
      ...settings,
      hosts,
      guests,
      externalSites: externalSites.length > 0 ? externalSites : undefined,
    });

    const result = InventorySchema.safeParse(assembled);
    if (!result.success) {
      const messages = result.error.issues.map(
        (issue) => `Inventory validation: ${issue.path.join('.')}: ${issue.message}`
      );
      throw new Error(messages.join('\n'));
    }
    const errors = validateInventory(result.data);
    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
    return result.data;
  } finally {
    db.close();
  }
}

// Called on every /api request (src/web/app.ts) so the web UI reflects
// inventory changes written by another process -- a direct DB edit, a CLI
// command run while the service is up, a hand-edit -- without needing a
// service restart (issue #98). Mutates the existing object in place rather
// than returning a new one so every route module's closure over the single
// shared `inventory` reference (captured once in buildApp) sees fresh data
// with no changes to the route files themselves.
export function refreshInventory(inventory: Inventory, path: string): void {
  let fresh: Inventory;
  try {
    fresh = loadInventory(path);
  } catch (err) {
    logWarn(`Failed to reload inventory from ${path}, continuing with the in-memory copy: ${(err as Error).message}`);
    return;
  }
  // Object.assign alone only overwrites keys `fresh` still has -- it can't
  // clear one, since a cleared optional top-level scalar (nfsServer et al,
  // issue #124) is simply absent from `fresh` rather than present as
  // `undefined`. Delete any own key `inventory` has that `fresh` no longer
  // carries before assigning, so an operator clearing a setting (via the
  // web UI, `set-config --apply`, or a hand-edit) is reflected on the very
  // next reload instead of the stale value surviving until a service
  // restart. Found live: the Settings page's Clear button appeared to
  // succeed (200 response) but the value never actually cleared in the
  // shared in-memory copy every route reads.
  for (const key of Object.keys(inventory) as (keyof Inventory)[]) {
    if (!(key in fresh)) delete inventory[key];
  }
  Object.assign(inventory, fresh);
}

// For a caller that loaded the inventory, then awaited something slow (an
// SSH round trip, a reboot, a TLS probe) before saving it back: every
// setting is taken from the database as it is now, everything else from
// `inventory`. saveInventory rewrites the whole meta table, so saving the
// stale copy as-is would silently revert a setting saved meanwhile -- on
// the Settings page, by set-config, or by the MCP server (issue #64 moved
// the integration settings there, which made such a save far more likely
// to land mid-command). A missing database has nothing newer to keep.
export function withFreshSettings(path: string, inventory: Inventory): Inventory {
  if (!existsSync(path)) return inventory;
  const fresh = loadInventory(path);
  const merged: Inventory = { ...inventory };
  for (const key of SETTINGS_KEYS) assignSetting(merged, key, fresh[key]);
  return merged;
}

// Mirrors web-client/src/pages/Dashboard.tsx's compareIp -- keep both in
// sync if this changes. Duplicated rather than shared because web-client
// is a fully separate build (own tsconfig/Vite) with no imports from src/.
function compareIp(a: string | undefined, b: string | undefined): number {
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

function compareByName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Mirrors web-client/src/pages/Dashboard.tsx's sortGuestsForDisplay -- keep
// both in sync if this changes.
function compareGuests(a: GuestEntry, b: GuestEntry): number {
  if (a.host !== b.host) return a.host < b.host ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const ipCmp = compareIp(a.ip, b.ip);
  if (ipCmp !== 0) return ipCmp;
  return compareByName(a, b);
}

function compareNfsMounts(a: NfsMountEntry, b: NfsMountEntry): number {
  const nameCmp = compareByName(a, b);
  if (nameCmp !== 0) return nameCmp;
  return a.mountPoint < b.mountPoint ? -1 : a.mountPoint > b.mountPoint ? 1 : 0;
}

// Keeps bellhop.db deterministically ordered on both load and save (loadInventory
// runs this on the assembled result, saveInventory runs it again on the way
// in) -- matching the Dashboard's own guest display order (compareGuests
// above) and closing the only real source of sync-inventory non-idempotency:
// Zod already normalizes per-entry *field* order on every load (object keys
// come out in schema-declaration order regardless of source order), so
// array element order -- driven by whatever order Proxmox's own API
// happens to return guests/interfaces/storage pools in -- was the only
// thing that could still drift between two otherwise-identical runs.
export function sortInventoryForFile(inv: Inventory): Inventory {
  return {
    ...inv,
    hosts: inv.hosts
      .slice()
      .sort(compareByName)
      .map((host) => ({
        ...host,
        bridges: host.bridges?.slice().sort(compareByName),
        storages: host.storages
          ?.map((s) => ({ ...s, content: [...s.content].sort() }))
          .sort(compareByName),
        nfsMounts: host.nfsMounts?.slice().sort(compareNfsMounts),
      })),
    guests: inv.guests.slice().sort(compareGuests),
  };
}

export function saveInventory(path: string, inv: Inventory): void {
  const errors = validateInventory(inv);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  const sorted = sortInventoryForFile(inv);
  const db = openInventoryDb(path);
  try {
    const tx = db.transaction((data: Inventory) => {
      db.prepare('DELETE FROM subdomains').run();
      db.prepare('DELETE FROM proxy_owner').run();
      db.prepare('DELETE FROM guests').run();
      db.prepare('DELETE FROM external_sites').run();
      db.prepare('DELETE FROM hosts').run();

      const upsertMeta = db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      const deleteMeta = db.prepare('DELETE FROM meta WHERE key = ?');
      upsertMeta.run('domain', data.domain);
      // An undefined field DELETEs its row rather than being skipped --
      // otherwise clearing a setting would silently leave the old value in
      // the DB and it would come straight back on the next load.
      for (const key of SETTINGS_KEYS) {
        const value = data[key];
        if (value === undefined) deleteMeta.run(key);
        else upsertMeta.run(key, value);
      }

      const insertHost = db.prepare(`
        INSERT INTO hosts (name, ssh_target, ssh_user, ssh_port, ssh_identity_file, proxy, proxy_manual, ip, port, insecure_backend_tls, bridges_json, storages_json, nfs_mounts_json, auth_group, auth_mode, oidc_redirect_uris_json, oidc_mobile_redirect_uris_json, authentik, mid_scheme_json, unauthenticated_paths_json)
        VALUES (@name, @ssh_target, @ssh_user, @ssh_port, @ssh_identity_file, @proxy, @proxy_manual, @ip, @port, @insecure_backend_tls, @bridges_json, @storages_json, @nfs_mounts_json, @auth_group, @auth_mode, @oidc_redirect_uris_json, @oidc_mobile_redirect_uris_json, @authentik, @mid_scheme_json, @unauthenticated_paths_json)
      `);
      const insertSubdomain = db.prepare(
        'INSERT INTO subdomains (subdomain, owner_type, owner_name) VALUES (?, ?, ?)'
      );
      const insertProxyOwner = db.prepare(
        'INSERT INTO proxy_owner (id, owner_type, owner_name) VALUES (1, ?, ?)'
      );

      for (const host of data.hosts) {
        insertHost.run({
          name: host.name,
          ssh_target: host.ssh_target,
          ssh_user: host.ssh_user,
          ssh_port: host.ssh_port ?? null,
          ssh_identity_file: host.ssh_identity_file ?? null,
          proxy: host.proxy ? 1 : 0,
          proxy_manual: host.proxyManual ? 1 : null,
          ip: host.ip ?? null,
          port: host.port ?? null,
          insecure_backend_tls: host.insecureBackendTls == null ? null : host.insecureBackendTls ? 1 : 0,
          auth_group: host.authGroup ?? null,
          auth_mode: host.authMode ?? null,
          oidc_redirect_uris_json: host.oidcRedirectUris ? JSON.stringify(host.oidcRedirectUris) : null,
          oidc_mobile_redirect_uris_json: host.oidcMobileRedirectUris ? JSON.stringify(host.oidcMobileRedirectUris) : null,
          authentik: host.authentik ? 1 : null,
          bridges_json: host.bridges ? JSON.stringify(host.bridges) : null,
          storages_json: host.storages ? JSON.stringify(host.storages) : null,
          nfs_mounts_json: host.nfsMounts ? JSON.stringify(host.nfsMounts) : null,
          mid_scheme_json: host.midScheme ? JSON.stringify(host.midScheme) : null,
          unauthenticated_paths_json: host.unauthenticatedPaths ? JSON.stringify(host.unauthenticatedPaths) : null,
        });
        if (host.proxy) insertProxyOwner.run('host', host.name);
        for (const subdomain of host.subdomains ?? []) insertSubdomain.run(subdomain, 'host', host.name);
      }

      const insertGuest = db.prepare(`
        INSERT INTO guests (name, type, vmid, host, ip, port, insecure_backend_tls, proxy, proxy_manual, unprivileged, app, app_source, vpn_gateway, vpn, created_by_uid, created_by_username, created_by_since, auth_group, auth_mode, oidc_redirect_uris_json, oidc_mobile_redirect_uris_json, authentik, unauthenticated_paths_json)
        VALUES (@name, @type, @vmid, @host, @ip, @port, @insecure_backend_tls, @proxy, @proxy_manual, @unprivileged, @app, @app_source, @vpn_gateway, @vpn, @created_by_uid, @created_by_username, @created_by_since, @auth_group, @auth_mode, @oidc_redirect_uris_json, @oidc_mobile_redirect_uris_json, @authentik, @unauthenticated_paths_json)
      `);
      for (const guest of data.guests) {
        insertGuest.run({
          name: guest.name,
          type: guest.type,
          vmid: guest.vmid,
          host: guest.host,
          ip: guest.ip ?? null,
          port: guest.port ?? null,
          insecure_backend_tls: guest.insecureBackendTls == null ? null : guest.insecureBackendTls ? 1 : 0,
          proxy: guest.proxy ? 1 : 0,
          proxy_manual: guest.proxyManual ? 1 : null,
          unprivileged: guest.unprivileged === undefined ? null : guest.unprivileged ? 1 : 0,
          app: guest.app ?? null,
          app_source: guest.appSource ?? null,
          vpn_gateway: guest.vpnGateway ?? null,
          vpn: guest.vpn ?? null,
          created_by_uid: guest.creator?.uid ?? null,
          created_by_username: guest.creator?.username ?? null,
          created_by_since: guest.creator?.since ?? null,
          auth_group: guest.authGroup ?? null,
          auth_mode: guest.authMode ?? null,
          oidc_redirect_uris_json: guest.oidcRedirectUris ? JSON.stringify(guest.oidcRedirectUris) : null,
          oidc_mobile_redirect_uris_json: guest.oidcMobileRedirectUris ? JSON.stringify(guest.oidcMobileRedirectUris) : null,
          authentik: guest.authentik ? 1 : null,
          unauthenticated_paths_json: guest.unauthenticatedPaths ? JSON.stringify(guest.unauthenticatedPaths) : null,
        });
        if (guest.proxy) insertProxyOwner.run('guest', guest.name);
        for (const subdomain of guest.subdomains ?? []) insertSubdomain.run(subdomain, 'guest', guest.name);
      }

      const insertExternalSite = db.prepare(`
        INSERT INTO external_sites (name, ip, port, insecure_backend_tls, auth_group, auth_mode, oidc_redirect_uris_json, oidc_mobile_redirect_uris_json, unauthenticated_paths_json)
        VALUES (@name, @ip, @port, @insecure_backend_tls, @auth_group, @auth_mode, @oidc_redirect_uris_json, @oidc_mobile_redirect_uris_json, @unauthenticated_paths_json)
      `);
      for (const site of data.externalSites ?? []) {
        insertExternalSite.run({
          name: site.name,
          ip: site.ip,
          port: site.port ?? null,
          insecure_backend_tls: site.insecureBackendTls == null ? null : site.insecureBackendTls ? 1 : 0,
          auth_group: site.authGroup ?? null,
          auth_mode: site.authMode ?? null,
          oidc_redirect_uris_json: site.oidcRedirectUris ? JSON.stringify(site.oidcRedirectUris) : null,
          oidc_mobile_redirect_uris_json: site.oidcMobileRedirectUris ? JSON.stringify(site.oidcMobileRedirectUris) : null,
          unauthenticated_paths_json: site.unauthenticatedPaths ? JSON.stringify(site.unauthenticatedPaths) : null,
        });
        for (const subdomain of site.subdomains) insertSubdomain.run(subdomain, 'external_site', site.name);
      }
    });

    tx(sorted);
  } finally {
    db.close();
    // The moved settings are meta rows, so a save can change what the
    // config accessor should return -- drop its snapshot rather than serve
    // the pre-save values for up to its TTL (issue #64, research R3).
    invalidateConfigSnapshot();
  }
}

// The single entry flagged `proxy: true` -- where the reverse proxy runs.
// Shared by render-status-page and scripts/windows-service.ts (whose
// firewall rule scopes inbound access to that entry's ip), so neither has
// to re-derive it or hardcode an address.
export function findProxyEntry(inv: Inventory): HostEntry | GuestEntry | undefined {
  return [...inv.hosts, ...inv.guests].find((e) => e.proxy);
}
