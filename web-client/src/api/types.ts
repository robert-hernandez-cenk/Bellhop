export type FieldKind =
  | 'select-host'
  | 'select-guest'
  | 'select-guest-lxc'
  | 'select-common'
  | 'select-strict'
  | 'select-bridge'
  | 'select-storage'
  | 'select-nfs-mount'
  | 'target-selector'
  | 'text'
  | 'secret'
  | 'number'
  | 'mid'
  | 'subdomains'
  | 'checkbox'
  | 'app-check'
  | 'vpn-gateway-name';

export interface AppDefaults {
  cores?: number;
  memory?: number;
  disk?: number;
  port?: number;
}

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  required?: boolean;
  checkEndpoint?: string;
  storageContentTypes?: string[];
  // Which field in `values` a select-storage/mid field reads its host from
  // (`hosts.find(h => h.name === values[hostField])`), defaulting to 'host'.
  // Every select-storage/mid field except migrate-guest's is scoped to the
  // plain 'host' field; migrate-guest's is scoped to 'toHost' instead,
  // since it targets a *different* host than wherever the guest currently
  // lives and has no plain 'host' field on its form at all.
  hostField?: string;
  showIf?: { field: string; value: string };
}

export interface ProvisioningCommandDef {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  warning?: string;
}

export interface MaintenanceActionDef {
  id: string;
  label: string;
  description: string;
  mode: 'read-only' | 'run-only' | 'preview-apply';
  fields: FieldDef[];
}

export interface BridgeEntry {
  name: string;
  alias?: string;
  active?: boolean;
}

export interface StorageEntry {
  name: string;
  type: string;
  content: string[];
  active: boolean;
  totalBytes?: number;
}

export interface NfsMountEntry {
  name: string;
  export: string;
  mountPoint: string;
  active: boolean;
}

export interface HostEntry {
  name: string;
  ssh_target: string;
  ssh_user: string;
  ssh_port?: number;
  midScheme?: { vmidBase: number; ipPrefix: string; cidrSuffix?: number; gateway: string };
  caddy?: boolean;
  bridges?: BridgeEntry[];
  storages?: StorageEntry[];
  nfsMounts?: NfsMountEntry[];
  subdomains?: string[];
}

export interface GuestEntry {
  name: string;
  type: 'lxc' | 'vm';
  vmid: number;
  host: string;
  ip?: string;
  port?: number;
  subdomains?: string[];
  caddyManual?: boolean;
  insecureBackendTls?: boolean;
  // The Authentik group ladder rung gating this entry, or absent/null when
  // ungated. Mirrors the server's authGroup (src/lib/inventory.ts).
  authGroup?: string | null;
  // Native OIDC gating (issue #1). Only meaningful when authGroup is set --
  // "effective OIDC" everywhere in this build means authGroup && authMode
  // === 'oidc' (src/lib/oidc.ts's isOidcEffective, mirroring the server's
  // effectiveAuth() in src/lib/inventory.ts). Absent/'forward' both mean
  // forward-auth, matching the server's own default.
  authMode?: 'forward' | 'oidc';
  // Callback URLs Authentik's OpenID client redirects back to after a
  // sign-in, only meaningful in OIDC mode.
  oidcRedirectUris?: string[];
  unauthenticatedPaths?: string[];
  caddy?: boolean;
  app?: string;
  vpnGateway?: 'nordvpn' | 'pia';
  vpn?: string;
}

export interface GuestStatusResponse {
  statuses: Record<string, 'running' | 'stopped'>;
  failures: string[];
}

// Which of JobSSHClient's three detection tiers produced a pause -- see
// src/web/jobs/job-ssh-client.ts's own PromptOrigin (duplicated, not
// imported: web-client is a fully separate build with no imports from
// src/, see CLAUDE.md's "sortInventoryForFile" precedent for this
// pattern). Typed as a union rather than a bare string so a typo comparing
// against it (e.g. JobView.tsx's `promptOrigin === 'stall'`) is a compile
// error instead of a silently-missing UI hint. Issue #160.
export type PromptOrigin = 'expected' | 'heuristic' | 'stall';

export interface JobRow {
  id: number;
  command: string;
  category: 'provisioning' | 'maintenance';
  target: string | null;
  status: 'queued' | 'running' | 'awaiting_input' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  promptText: string | null;
  expectedPromptsJson: string | null;
  promptOrigin: PromptOrigin | null;
  promptMatchedIndex: number | null;
  triggeredByUsername: string | null;
  triggeredByImpersonating: string | null;
}

export interface GatewayStatus {
  connected: boolean;
  country: string;
  resolvedCountry?: string;
  city?: string;
  resolvedCity?: string;
  group?: string;
  publicIp?: string;
  server: string;
  dns: string;
  since: string;
  lastHealthCheck: string;
  lastHealthCheckOk: boolean;
}

export interface GatewayCountry {
  name: string;
  code: string;
}

export interface GatewayCity {
  name: string;
  id: string;
}

export interface GatewayGroup {
  name: string;
  identifier: string;
}

export interface AuthentikUserEntry {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
  groupIds: string[];
}

export interface AuthentikGroupEntry {
  id: string;
  name: string;
  userIds: string[];
}

export type PermissionMode = 'allow-list' | 'block-list';

export interface ResourceRef {
  type: 'host' | 'guest';
  name: string;
}

export interface GroupPermissionEntry {
  groupName: string;
  mode: PermissionMode;
  resources: ResourceRef[];
}

export interface SettingsValues {
  nfsServer?: string;
  backupStorage?: string;
  dnsServer?: string;
  statusPagePath?: string;
}

export interface SettingsResponse {
  settings: SettingsValues;
  derived: {
    lanGateways: Array<{ host: string; gateway: string }>;
    caddy: { name: string; ip: string } | null;
  };
}
