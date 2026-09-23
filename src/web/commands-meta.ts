import { TEMPLATE_OPTIONS, CORE_OPTIONS, MEMORY_OPTIONS, DISK_OPTIONS, VPN_PROVIDER_OPTIONS } from './field-options.ts';

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

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  required?: boolean;
  // Only for kind: 'app-check' — GET path (relative to /api) that resolves
  // the current value to a script URL and reports whether it's fetchable.
  checkEndpoint?: string;
  // Only for kind: 'select-storage' — which Proxmox storage content types
  // (e.g. 'vztmpl', 'rootdir', 'images') the selected host's storages[] is
  // filtered to.
  storageContentTypes?: string[];
  // Only for kind: 'select-storage'/'mid' — which field in the form's
  // values that field reads its host from, defaulting to 'host'. Every
  // select-storage/mid field except migrate-guest's is scoped to the plain
  // 'host' field; migrate-guest's is scoped to 'toHost' instead, since it
  // targets a *different* host than wherever the guest currently lives and
  // has no plain 'host' field on its form at all. Mirrored in
  // web-client/src/api/types.ts's own FieldDef -- see that copy's comment
  // for how the web client's FieldInput/ProvisioningForm use it.
  hostField?: string;
  // This field only renders when another field in the same form currently
  // holds this exact value -- e.g. a VPN provider's own credential fields,
  // which only make sense once that provider is selected. It is still
  // always submitted in the request body (as '' when hidden); only
  // rendering is conditional.
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

const CORE_MEM_DISK_BRIDGE: FieldDef[] = [
  { name: 'cores', label: 'Cores', kind: 'select-common', options: CORE_OPTIONS },
  { name: 'memory', label: 'Memory (MB)', kind: 'select-common', options: MEMORY_OPTIONS },
  { name: 'disk', label: 'Disk (GB)', kind: 'select-common', options: DISK_OPTIONS },
  { name: 'bridge', label: 'Network Bridge', kind: 'select-bridge' },
];

const SUBDOMAINS_FIELD: FieldDef = { name: 'subdomains', label: 'Subdomains (;-separated)', kind: 'subdomains' };

// Grouped by provider so adding a third VPN provider later means adding one
// more constant here, not touching deploy-vpn-gateway's field list shape or
// any rendering logic (ProvisioningForm.tsx/FieldInput.tsx just read
// showIf/kind generically).
const NORDVPN_CREDENTIAL_FIELDS: FieldDef[] = [
  {
    name: 'accessToken',
    label: 'NordVPN Access Token',
    kind: 'secret',
    required: true,
    showIf: { field: 'vpn', value: 'nordvpn' },
  },
];

const PIA_CREDENTIAL_FIELDS: FieldDef[] = [
  { name: 'piaUsername', label: 'PIA Username', kind: 'text', required: true, showIf: { field: 'vpn', value: 'pia' } },
  { name: 'piaPassword', label: 'PIA Password', kind: 'secret', required: true, showIf: { field: 'vpn', value: 'pia' } },
];

// Kept in alphabetical order by label by hand -- this is a manual
// convention (see issue #5), not enforced by sorting code. When adding a
// new command, insert it in alphabetical position.
export const PROVISIONING_COMMANDS: ProvisioningCommandDef[] = [
  {
    id: 'attach-nfs-mount',
    label: 'Attach NFS Mount',
    description: "Attach an lxc guest to an existing NFS storage entry via a host-relay bind-mount.",
    warning: 'This restarts the guest — brief outage.',
    fields: [
      { name: 'guest', label: 'Guest', kind: 'select-guest-lxc', required: true },
      { name: 'storage', label: 'NFS Mount', kind: 'select-nfs-mount', required: true },
      { name: 'mountPoint', label: 'Mount point', kind: 'text', required: true },
    ],
  },
  {
    id: 'configure-guest',
    label: 'Configure Guest',
    description: 'Install packages and/or add an SSH public key on an existing guest.',
    fields: [
      { name: 'guest', label: 'Guest', kind: 'select-guest', required: true },
      { name: 'packages', label: 'Packages (space-separated)', kind: 'text' },
      { name: 'sshKey', label: 'SSH public key', kind: 'text' },
    ],
  },
  {
    id: 'create-lxc',
    label: 'Create LXC',
    description: 'Create a new LXC container on a Proxmox host.',
    fields: [
      { name: 'host', label: 'Host', kind: 'select-host', required: true },
      { name: 'mid', label: 'MID (2-252)', kind: 'mid', required: true },
      { name: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { name: 'template', label: 'Template', kind: 'select-common', options: TEMPLATE_OPTIONS, required: true },
      ...CORE_MEM_DISK_BRIDGE,
      { name: 'storage', label: 'Storage', kind: 'select-storage', storageContentTypes: ['rootdir', 'images'] },
      SUBDOMAINS_FIELD,
      { name: 'insecureBackendTls', label: 'Backend serves untrusted/self-signed TLS', kind: 'checkbox' },
      { name: 'nfsStorage', label: 'NFS Mount (optional)', kind: 'select-nfs-mount' },
      { name: 'nfsMountPoint', label: 'NFS Mount Point', kind: 'text' },
    ],
  },
  {
    id: 'create-vm',
    label: 'Create VM',
    description: 'Create a new VM on a Proxmox host.',
    fields: [
      { name: 'host', label: 'Host', kind: 'select-host', required: true },
      { name: 'mid', label: 'MID (2-252)', kind: 'mid', required: true },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      ...CORE_MEM_DISK_BRIDGE,
      { name: 'diskStorage', label: 'Disk Storage', kind: 'select-storage', storageContentTypes: ['images'] },
      { name: 'cloudInit', label: 'Attach cloud-init drive', kind: 'checkbox' },
      SUBDOMAINS_FIELD,
      { name: 'insecureBackendTls', label: 'Backend serves untrusted/self-signed TLS', kind: 'checkbox' },
    ],
  },
  {
    id: 'deploy-vpn-gateway',
    label: 'Deploy VPN Gateway',
    description: 'Create a new VPN gateway LXC (NordVPN or PIA) that other guests can route through.',
    fields: [
      { name: 'vpn', label: 'VPN Provider', kind: 'select-strict', options: VPN_PROVIDER_OPTIONS, required: true },
      { name: 'host', label: 'Host', kind: 'select-host', required: true },
      { name: 'mid', label: 'MID (2-252)', kind: 'mid', required: true },
      { name: 'name', label: 'Name', kind: 'vpn-gateway-name', required: true },
      ...NORDVPN_CREDENTIAL_FIELDS,
      ...PIA_CREDENTIAL_FIELDS,
      { name: 'storage', label: 'Storage', kind: 'select-storage', storageContentTypes: ['rootdir', 'images'] },
    ],
  },
  {
    id: 'install-app',
    label: 'Install App',
    description:
      'Create a new LXC container by running a community-scripts (ProxmoxVE) install script unattended.',
    fields: [
      {
        name: 'app',
        label: 'App (slug or full script URL)',
        kind: 'app-check',
        checkEndpoint: '/provisioning/install-app/check-app',
        required: true,
      },
      { name: 'host', label: 'Host', kind: 'select-host', required: true },
      { name: 'mid', label: 'MID (2-252)', kind: 'mid', required: true },
      { name: 'hostname', label: 'Hostname', kind: 'text', required: true },
      ...CORE_MEM_DISK_BRIDGE,
      { name: 'templateStorage', label: 'Template Storage', kind: 'select-storage', storageContentTypes: ['vztmpl'] },
      {
        name: 'containerStorage',
        label: 'Container Storage',
        kind: 'select-storage',
        storageContentTypes: ['rootdir', 'images'],
      },
      { name: 'port', label: 'Port', kind: 'number' },
      SUBDOMAINS_FIELD,
      // No insecureBackendTls checkbox here (unlike create-lxc/create-vm,
      // see their own field lists above): install-app is the one command
      // whose recordProvisionedGuest call actually has a port at creation
      // time, so it's also the only one whose newly-created guest gets a
      // live TLS probe (src/lib/tls-probe.ts, issue #100) right away --
      // manually guessing this checkbox is no longer useful here. A probe
      // left inconclusive after its retry budget still leaves
      // insecureBackendTls unset, fixable afterward via the Dashboard's
      // own checkbox (EditableInsecureBackendTls.tsx).
      { name: 'nfsStorage', label: 'NFS Mount (optional)', kind: 'select-nfs-mount' },
      { name: 'nfsMountPoint', label: 'NFS Mount Point', kind: 'text' },
    ],
  },
  {
    id: 'migrate-guest',
    label: 'Migrate Guest',
    description: "Move an existing lxc/vm guest to another Proxmox host, renumbering its VMID/IP to match the target host's convention.",
    warning:
      'Backs up the guest, restores it on the target host under a new VMID, then destroys the original once the new guest is verified running -- this cannot be undone.',
    fields: [
      { name: 'guest', label: 'Guest', kind: 'select-guest', required: true },
      { name: 'toHost', label: 'Target Host', kind: 'select-host', required: true },
      {
        name: 'mid',
        label: 'MID (2-252, optional -- defaults to the current vmid\'s numeric suffix)',
        kind: 'mid',
        hostField: 'toHost',
      },
      { name: 'backupStorage', label: 'Backup Storage (optional -- defaults to the configured backupStorage)', kind: 'text' },
      // hostField: 'toHost' -- unlike every other select-storage field
      // (create-lxc/create-vm/install-app/deploy-vpn-gateway), this one is
      // scoped to the *target* host, not "wherever the guest already is"
      // (there's no plain 'host' field on this form at all -- 'toHost' is
      // the only host selector).
      {
        name: 'storage',
        label: 'Storage (optional -- defaults to automatic)',
        kind: 'select-storage',
        storageContentTypes: ['rootdir', 'images'],
        hostField: 'toHost',
      },
    ],
  },
  // migrate-nfs-mount is deliberately not listed here -- every guest has
  // already been migrated to the host-relay bind-mount pattern, so it has
  // no remaining use in the web UI. The CLI command
  // (`bellhop migrate-nfs-mount`) and its web route handler
  // (src/web/routes/provisioning.ts) are both left intact for a one-off
  // future need; only its discoverability here is removed.
];

// Kept in alphabetical order by label by hand -- this is a manual
// convention (see issue #5), not enforced by sorting code. When adding a
// new action, insert it in alphabetical position.
export const MAINTENANCE_ACTIONS: MaintenanceActionDef[] = [
  {
    id: 'audit-nfs-mounts',
    label: 'Audit NFS Mounts',
    description: 'Read-only report of NFS shares mounted across lxc guests.',
    mode: 'read-only',
    fields: [{ name: 'host', label: 'Guest (optional)', kind: 'select-guest-lxc' }],
  },
  {
    id: 'sync-caddy',
    label: 'Sync Caddy',
    description: 'Generate and write Caddy reverse_proxy blocks from inventory subdomains.',
    mode: 'preview-apply',
    fields: [],
  },
  {
    id: 'sync-inventory',
    label: 'Sync Inventory',
    description: "Reconcile inventory/bellhop.db's guests and each host's bridges with live Proxmox state.",
    mode: 'preview-apply',
    fields: [],
  },
];
