import { z } from 'zod';
import { buildAuthorizedKeysEnsurePresentScript } from '../../lib/authorized-keys.ts';
import { refreshInventory, saveInventory, type HostEntry, type Inventory, type MidScheme } from '../../lib/inventory.ts';
import { suggestMidScheme } from '../../lib/mid-suggest.ts';
import { clusterPeers, parseVersion, primaryBridgeAddress, type ClusterPeer } from '../../lib/pve-discovery.ts';
import { hostSshTarget } from '../../lib/targets.ts';
import type { SSHClient, SshTarget } from '../../lib/ssh-client.ts';
import { MAINTENANCE_OPERATIONS } from '../../operations/maintenance.ts';
import type { OperationDeps } from '../../operations/types.ts';

// Step 1 of the first-run setup walkthrough (issue #86, research R6/R7/R9):
// key install, connection test, host save, cluster peers. The actions are
// synchronous and idempotent (R12); each throws a SetupActionError whose
// message is safe to show, because it never carries anything from the
// underlying ssh2 error (which could echo a password).

export class SetupActionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

// What the operator types for one host. The user becomes part of a
// filesystem path in the key-install script, so it is a plain account name.
export const HostEndpointSchema = z.object({
  address: z
    .string()
    .trim()
    .min(1, 'is required')
    .refine((v) => !/\s/.test(v), 'must not contain whitespace'),
  user: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_-]*$/i, 'must be a plain account name such as root')
    .default('root'),
  port: z.number().int().min(1).max(65535).default(22),
});
export type HostEndpoint = z.infer<typeof HostEndpointSchema>;

export const InstallKeyRequestSchema = HostEndpointSchema.extend({
  password: z
    .string()
    .min(1, 'is required')
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must not contain control characters'),
});

function endpointLabel(e: HostEndpoint): string {
  return `${e.user}@${e.address}:${e.port}`;
}

function portField(e: HostEndpoint): { port?: number } {
  return e.port === 22 ? {} : { port: e.port };
}

// One password connection that makes sure Bellhop's public key is in the
// user's authorized_keys (FR-010). The password lives only in this call's
// SshTarget.
export async function installKey(
  ssh: SSHClient,
  endpoint: HostEndpoint,
  password: string,
  authorizedKeysLine: string
): Promise<void> {
  const sshDir = endpoint.user === 'root' ? '/root/.ssh' : `/home/${endpoint.user}/.ssh`;
  const target: SshTarget = { host: endpoint.address, user: endpoint.user, ...portField(endpoint), password };
  const failure = new SetupActionError(
    `password login failed for ${endpointLabel(endpoint)} -- check the password, or add the key by hand`,
    502
  );
  let result;
  try {
    result = await ssh.exec(target, buildAuthorizedKeysEnsurePresentScript(authorizedKeysLine, sshDir));
  } catch {
    throw failure;
  }
  if (result.code !== 0) throw failure;
}

export interface TestedHost {
  nodeName: string;
  version: string;
}

// Key-based connection test (FR-011): also proves the machine is a Proxmox
// node and reads its node name.
export async function testHost(ssh: SSHClient, endpoint: HostEndpoint, keyPath: string): Promise<TestedHost> {
  const target: SshTarget = {
    host: endpoint.address,
    user: endpoint.user,
    ...portField(endpoint),
    identityFile: keyPath,
  };
  let result;
  try {
    result = await ssh.exec(target, 'hostname && pvesh get /version --output-format json');
  } catch (err) {
    throw new SetupActionError(
      `could not connect to ${endpointLabel(endpoint)} with Bellhop's key -- check the address and port, and that the key is installed (${(err as Error).message})`,
      502
    );
  }
  if (result.code !== 0) {
    throw new SetupActionError(
      `${endpointLabel(endpoint)} answered, but is not a Proxmox node (pvesh failed: ${result.stderr.trim() || `exit ${result.code}`})`,
      502
    );
  }
  const [nodeName, ...rest] = result.stdout.trim().split('\n');
  try {
    return { nodeName: nodeName.trim(), version: parseVersion(rest.join('\n')) };
  } catch {
    throw new SetupActionError(`${endpointLabel(endpoint)} did not answer like a Proxmox node`, 502);
  }
}

export interface SavedHost {
  host: HostEntry;
  suggestedMidScheme: MidScheme | undefined;
  peers: (ClusterPeer & { inInventory: boolean })[];
}

// Saves the host under its node name (FR-012/FR-015): upsert, then the
// existing sync-inventory apply for its bridges, storage and guests, then the
// cluster peers and the midScheme suggestion from the host's own network.
export async function saveHost(
  deps: OperationDeps,
  endpoint: HostEndpoint,
  keyPath: string
): Promise<SavedHost> {
  const { ssh, inventory, inventoryPath } = deps;
  const { nodeName } = await testHost(ssh, endpoint, keyPath);

  if (inventory.guests.some((g) => g.name === nodeName) || (inventory.externalSites ?? []).some((s) => s.name === nodeName)) {
    throw new SetupActionError(
      `"${nodeName}" is already the name of a guest or site in the inventory -- rename it before adding this host`,
      409
    );
  }

  const existing = inventory.hosts.find((h) => h.name === nodeName);
  const entry: HostEntry = {
    ...existing,
    name: nodeName,
    ssh_target: endpoint.address,
    ssh_user: endpoint.user,
    ssh_identity_file: keyPath,
  };
  if (endpoint.port === 22) delete entry.ssh_port;
  else entry.ssh_port = endpoint.port;
  const hosts = existing ? inventory.hosts.map((h) => (h.name === nodeName ? entry : h)) : [...inventory.hosts, entry];
  saveInventory(inventoryPath, { ...inventory, hosts });
  refreshInventory(inventory, inventoryPath);

  await MAINTENANCE_OPERATIONS['sync-inventory'].apply({}, deps);
  refreshInventory(inventory, inventoryPath);

  const saved = inventory.hosts.find((h) => h.name === nodeName)!;
  let peers: ClusterPeer[] = [];
  try {
    const result = await ssh.exec(hostSshTarget(saved), 'pvesh get /cluster/status --output-format json');
    if (result.code === 0) peers = clusterPeers(result.stdout);
  } catch {
    // A standalone or unreadable answer simply offers no peers.
  }

  return {
    host: saved,
    suggestedMidScheme: await suggestMidSchemeFor(ssh, inventory, saved),
    peers: peers.map((p) => ({ ...p, inInventory: inventory.hosts.some((h) => h.name === p.name) })),
  };
}

// The midScheme suggestion from the host's own network (FR-014): none when
// the host can't be asked or has no bridge with an IPv4 address and gateway.
export async function suggestMidSchemeFor(
  ssh: SSHClient,
  inventory: Inventory,
  host: HostEntry
): Promise<MidScheme | undefined> {
  try {
    const result = await ssh.exec(hostSshTarget(host), `pvesh get /nodes/${host.name}/network --output-format json`);
    if (result.code !== 0) return undefined;
    return suggestMidScheme(
      primaryBridgeAddress(result.stdout),
      inventory.hosts.filter((h) => h.name !== host.name)
    );
  } catch {
    return undefined;
  }
}
