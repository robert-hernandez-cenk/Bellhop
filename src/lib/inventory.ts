import Database from 'better-sqlite3';
import { z } from 'zod';
import { logInfo, logWarn } from './log.ts';
import { openDb } from './sqlite.ts';
import { authentikConfig } from './authentik-config.ts';

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
  caddy: z.boolean().optional(),
  subdomains: z.array(z.string()).optional(),
  // When true, this entry's Caddy config is hand-authored elsewhere (e.g. a
  // block outside sync-caddy's managed markers) -- buildCaddyBlock skips
  // generating a site block for it entirely, even though its subdomains[]
  // still drives the Dashboard's service link.
  caddyManual: z.boolean().optional(),
  ip: z.string().optional(),
  port: z.number().optional(),
  // The reverse-proxied service's own backend speaks HTTPS with a
  // self-signed/otherwise-untrusted cert (e.g. the Proxmox web UI) -- tells
  // sync-caddy to add `transport http { tls_insecure_skip_verify }` so Caddy
  // doesn't refuse to connect to it.
  insecureBackendTls: z.boolean().optional(),
  // See ExternalSiteSchema's authGroup for what this does; also settable
  // on a host (e.g. the Proxmox web UI's own reverse-proxied subdomain).
  authGroup: z.string().min(1).optional(),
  unauthenticatedPaths: z.array(z.string().regex(/^\//, "must start with '/'")).optional(),
  // Marks this entry as the Authentik instance itself -- mirrors caddy:
  // true's "exactly one entry" role. sync-caddy resolves this entry's ip
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

export const GuestEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['lxc', 'vm']),
  vmid: z.number().int().positive(),
  host: z.string().min(1),
  ip: z.string().optional(),
  port: z.number().optional(),
  subdomains: z.array(z.string()).optional(),
  // See HostEntrySchema's caddyManual for what this does.
  caddyManual: z.boolean().optional(),
  insecureBackendTls: z.boolean().optional(),
  authGroup: z.string().min(1).optional(),
  unauthenticatedPaths: z.array(z.string().regex(/^\//, "must start with '/'")).optional(),
  authentik: z.boolean().optional(),
  caddy: z.boolean().optional(),
  unprivileged: z.boolean().optional(),
  // The community-scripts slug this guest was installed from (e.g. "plex"),
  // set once by install-app's apply step -- preserved the same way `port` is:
  // upsertGuestEntry (src/web/routes/provisioning.ts) explicitly carries it
  // forward when a repeat apply for the same host+vmid doesn't provide a new
  // one, and sync-inventory's merge never touches it since it never includes
  // an `app` key at all. Drives the Dashboard's community-scripts quick-open
  // link; undefined for any guest not created via install-app.
  app: z.string().optional(),
  // Marks this guest as a VPN gateway for a provider -- any number of
  // guests may share the same value (e.g. two 'nordvpn' gateways in
  // different regions). Set by deploy-vpn-gateway --apply on the guest it
  // creates.
  vpnGateway: z.enum(['nordvpn', 'pia']).optional(),
  // The *name* of the gateway guest (see vpnGateway above) this guest's
  // outbound traffic is currently routed through, or undefined if not
  // routed -- set/cleared by set-guest-vpn --apply.
  vpn: z.string().optional(),
});

// A Caddy reverse-proxy target that isn't a Proxmox host or guest at all
// (a NAS, a non-Proxmox box on the LAN, ...) -- never an SSH/exec target,
// never touched by resolveTarget/runRemote/sync-inventory; the only command
// that ever reads this array is sync-caddy.
export const ExternalSiteSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  port: z.number().optional(),
  subdomains: z.array(z.string()).min(1),
  insecureBackendTls: z.boolean().optional(),
  // Names the Authentik group ladder rung that gates this entry's
  // subdomain(s) -- sync-authentik binds the matching Application to that
  // rung and every rung above it (see AUTHENTIK_GROUP_LADDER in
  // src/lib/authentik-config.ts), and sync-caddy emits the forward_auth
  // directive. Absent means ungated. A no-op on an entry with no subdomains
  // (no candidate to gate) in both commands. caddyManual only silences
  // sync-caddy (which skips generating any block for such an entry) --
  // sync-authentik still creates/maintains the Provider/Application
  // regardless of caddyManual, since a hand-authored Caddy block may still
  // want to route through it. Ladder membership is deliberately NOT
  // validated here or in validateInventory: sync-authentik reports an
  // off-ladder value instead, so an AUTHENTIK_GROUP_LADDER edit can never
  // make an already-saved inventory refuse to load.
  authGroup: z.string().min(1).optional(),
  unauthenticatedPaths: z.array(z.string().regex(/^\//, "must start with '/'")).optional(),
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
});

export type Settings = z.infer<typeof SettingsSchema>;
export const SETTINGS_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[];

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
    caddy INTEGER NOT NULL DEFAULT 0,
    caddy_manual INTEGER,
    ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
    bridges_json TEXT,
    storages_json TEXT,
    nfs_mounts_json TEXT,
    unauthenticated_paths_json TEXT
  );
  CREATE TABLE IF NOT EXISTS guests (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    host TEXT NOT NULL REFERENCES hosts(name),
    ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
    caddy INTEGER NOT NULL DEFAULT 0,
    caddy_manual INTEGER,
    unprivileged INTEGER, app TEXT,
    unauthenticated_paths_json TEXT,
    UNIQUE (host, vmid)
  );
  CREATE TABLE IF NOT EXISTS external_sites (
    name TEXT PRIMARY KEY,
    ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER,
    unauthenticated_paths_json TEXT
  );
  CREATE TABLE IF NOT EXISTS subdomains (
    subdomain TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS caddy_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_type TEXT NOT NULL, owner_name TEXT NOT NULL
  );
`;

// Adds a column to an already-existing table when it's missing -- covers a
// real, already-populated inventory/bellhop.db, where SCHEMA's `CREATE TABLE IF
// NOT EXISTS` is a no-op and can't retroactively add a new column. Cheap and
// idempotent: a PRAGMA read plus a skipped ALTER TABLE once the column
// exists, run on every open.
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

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
  const ladder = authentikConfig().groupLadder;
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

function openInventoryDb(path: string): Database.Database {
  const db = openDb(path, SCHEMA);
  ensureColumn(db, 'hosts', 'caddy_manual', 'caddy_manual INTEGER');
  ensureColumn(db, 'guests', 'caddy_manual', 'caddy_manual INTEGER');
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

  const caddyNames = [
    ...inv.hosts.filter((h) => h.caddy).map((h) => h.name),
    ...inv.guests.filter((g) => g.caddy).map((g) => g.name),
  ];
  if (caddyNames.length > 1) {
    errors.push(
      `Inventory validation: multiple entries flagged 'caddy: true' (only one is allowed): ${caddyNames.join(' ')}`
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

  const gatedNames = [
    ...inv.hosts.filter((h) => h.authGroup).map((h) => h.name),
    ...inv.guests.filter((g) => g.authGroup).map((g) => g.name),
    ...(inv.externalSites ?? []).filter((s) => s.authGroup).map((s) => s.name),
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

  const allEntries: Array<{ name: string; subdomains?: string[]; ip?: string; caddyManual?: boolean }> = [
    ...inv.hosts,
    ...inv.guests,
    ...(inv.externalSites ?? []),
  ];
  for (const entry of allEntries) {
    // A caddyManual entry never produces a reverse_proxy target
    // (buildCaddyBlock skips it outright), so it doesn't need an ip the way
    // a normally-managed entry with subdomains does.
    if (entry.caddyManual) continue;
    if (entry.subdomains && entry.subdomains.length > 0 && !entry.ip) {
      errors.push(
        `Inventory validation: entry '${entry.name}' has 'subdomains' set but no 'ip' (would produce a broken reverse_proxy target)`
      );
    }
  }

  // Two entries claiming the same subdomain would silently fight over the
  // one Caddy site block sync-caddy generates for it -- catch that at
  // validation time rather than a confusing runtime Caddy behavior.
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
// `port: 80` (buildCaddyBlock's own `?? 80` default already covers that).
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

// Semicolon-delimited free text (the web UI's Unauthenticated Paths field)
// -> a deduplicated list of Caddy path-matcher globs, or undefined when
// empty so an entry with none doesn't grow a pointless
// `unauthenticatedPaths: []`. Throws on a non-empty pattern missing a
// leading '/', unlike parseSubdomains's silent-drop behavior -- a pattern
// that silently never matches as intended is a worse experience than a
// rejected save.
export function parseUnauthenticatedPaths(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const list = Array.from(new Set(raw.split(';').map((s) => s.trim()).filter(Boolean)));
  for (const pattern of list) {
    if (!pattern.startsWith('/')) {
      throw new Error(`Invalid unauthenticated path '${pattern}' (must start with '/')`);
    }
  }
  return list.length > 0 ? list : undefined;
}

interface HostRow {
  name: string;
  ssh_target: string;
  ssh_user: string;
  ssh_port: number | null;
  ssh_identity_file: string | null;
  mid_scheme_json: string | null;
  caddy: number;
  caddy_manual: number | null;
  ip: string | null;
  port: number | null;
  insecure_backend_tls: number | null;
  auth_group: string | null;
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
  authentik: number | null;
  caddy: number;
  caddy_manual: number | null;
  unprivileged: number | null;
  app: string | null;
  vpn_gateway: string | null;
  vpn: string | null;
  unauthenticated_paths_json: string | null;
}

interface ExternalSiteRow {
  name: string;
  ip: string;
  port: number | null;
  insecure_backend_tls: number | null;
  auth_group: string | null;
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
    // (sync-caddy treats the first subdomain as an entry's canonical
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
      caddy: row.caddy ? true : undefined,
      caddyManual: row.caddy_manual ? true : undefined,
      subdomains: subdomainsFor('host', row.name),
      ip: row.ip ?? undefined,
      port: row.port ?? undefined,
      insecureBackendTls: row.insecure_backend_tls == null ? undefined : row.insecure_backend_tls ? true : false,
      authGroup: row.auth_group ?? undefined,
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
      authentik: row.authentik ? true : undefined,
      caddy: row.caddy ? true : undefined,
      caddyManual: row.caddy_manual ? true : undefined,
      unprivileged: row.unprivileged === null ? undefined : !!row.unprivileged,
      app: row.app ?? undefined,
      vpnGateway: (row.vpn_gateway ?? undefined) as 'nordvpn' | 'pia' | undefined,
      vpn: row.vpn ?? undefined,
      unauthenticatedPaths: row.unauthenticated_paths_json ? JSON.parse(row.unauthenticated_paths_json) : undefined,
    }));

    const externalSites = externalSiteRows.map((row) => ({
      name: row.name,
      ip: row.ip,
      port: row.port ?? undefined,
      subdomains: subdomainsFor('external_site', row.name) ?? [],
      insecureBackendTls: row.insecure_backend_tls == null ? undefined : row.insecure_backend_tls ? true : false,
      authGroup: row.auth_group ?? undefined,
      unauthenticatedPaths: row.unauthenticated_paths_json ? JSON.parse(row.unauthenticated_paths_json) : undefined,
    }));

    const settings: Settings = {};
    for (const key of SETTINGS_KEYS) {
      const value = meta.get(key);
      if (value !== undefined) settings[key] = value;
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
      db.prepare('DELETE FROM caddy_owner').run();
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
        INSERT INTO hosts (name, ssh_target, ssh_user, ssh_port, ssh_identity_file, caddy, caddy_manual, ip, port, insecure_backend_tls, bridges_json, storages_json, nfs_mounts_json, auth_group, authentik, mid_scheme_json, unauthenticated_paths_json)
        VALUES (@name, @ssh_target, @ssh_user, @ssh_port, @ssh_identity_file, @caddy, @caddy_manual, @ip, @port, @insecure_backend_tls, @bridges_json, @storages_json, @nfs_mounts_json, @auth_group, @authentik, @mid_scheme_json, @unauthenticated_paths_json)
      `);
      const insertSubdomain = db.prepare(
        'INSERT INTO subdomains (subdomain, owner_type, owner_name) VALUES (?, ?, ?)'
      );
      const insertCaddyOwner = db.prepare(
        'INSERT INTO caddy_owner (id, owner_type, owner_name) VALUES (1, ?, ?)'
      );

      for (const host of data.hosts) {
        insertHost.run({
          name: host.name,
          ssh_target: host.ssh_target,
          ssh_user: host.ssh_user,
          ssh_port: host.ssh_port ?? null,
          ssh_identity_file: host.ssh_identity_file ?? null,
          caddy: host.caddy ? 1 : 0,
          caddy_manual: host.caddyManual ? 1 : null,
          ip: host.ip ?? null,
          port: host.port ?? null,
          insecure_backend_tls: host.insecureBackendTls == null ? null : host.insecureBackendTls ? 1 : 0,
          auth_group: host.authGroup ?? null,
          authentik: host.authentik ? 1 : null,
          bridges_json: host.bridges ? JSON.stringify(host.bridges) : null,
          storages_json: host.storages ? JSON.stringify(host.storages) : null,
          nfs_mounts_json: host.nfsMounts ? JSON.stringify(host.nfsMounts) : null,
          mid_scheme_json: host.midScheme ? JSON.stringify(host.midScheme) : null,
          unauthenticated_paths_json: host.unauthenticatedPaths ? JSON.stringify(host.unauthenticatedPaths) : null,
        });
        if (host.caddy) insertCaddyOwner.run('host', host.name);
        for (const subdomain of host.subdomains ?? []) insertSubdomain.run(subdomain, 'host', host.name);
      }

      const insertGuest = db.prepare(`
        INSERT INTO guests (name, type, vmid, host, ip, port, insecure_backend_tls, caddy, caddy_manual, unprivileged, app, vpn_gateway, vpn, auth_group, authentik, unauthenticated_paths_json)
        VALUES (@name, @type, @vmid, @host, @ip, @port, @insecure_backend_tls, @caddy, @caddy_manual, @unprivileged, @app, @vpn_gateway, @vpn, @auth_group, @authentik, @unauthenticated_paths_json)
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
          caddy: guest.caddy ? 1 : 0,
          caddy_manual: guest.caddyManual ? 1 : null,
          unprivileged: guest.unprivileged === undefined ? null : guest.unprivileged ? 1 : 0,
          app: guest.app ?? null,
          vpn_gateway: guest.vpnGateway ?? null,
          vpn: guest.vpn ?? null,
          auth_group: guest.authGroup ?? null,
          authentik: guest.authentik ? 1 : null,
          unauthenticated_paths_json: guest.unauthenticatedPaths ? JSON.stringify(guest.unauthenticatedPaths) : null,
        });
        if (guest.caddy) insertCaddyOwner.run('guest', guest.name);
        for (const subdomain of guest.subdomains ?? []) insertSubdomain.run(subdomain, 'guest', guest.name);
      }

      const insertExternalSite = db.prepare(`
        INSERT INTO external_sites (name, ip, port, insecure_backend_tls, auth_group, unauthenticated_paths_json)
        VALUES (@name, @ip, @port, @insecure_backend_tls, @auth_group, @unauthenticated_paths_json)
      `);
      for (const site of data.externalSites ?? []) {
        insertExternalSite.run({
          name: site.name,
          ip: site.ip,
          port: site.port ?? null,
          insecure_backend_tls: site.insecureBackendTls == null ? null : site.insecureBackendTls ? 1 : 0,
          auth_group: site.authGroup ?? null,
          unauthenticated_paths_json: site.unauthenticatedPaths ? JSON.stringify(site.unauthenticatedPaths) : null,
        });
        for (const subdomain of site.subdomains) insertSubdomain.run(subdomain, 'external_site', site.name);
      }
    });

    tx(sorted);
  } finally {
    db.close();
  }
}

// The single entry flagged `caddy: true` -- where Caddy actually runs.
// Shared by render-status-page and scripts/windows-service.ts (whose
// firewall rule scopes inbound access to that entry's ip), so neither has
// to re-derive it or hardcode an address.
export function findCaddyEntry(inv: Inventory): HostEntry | GuestEntry | undefined {
  return [...inv.hosts, ...inv.guests].find((e) => e.caddy);
}
