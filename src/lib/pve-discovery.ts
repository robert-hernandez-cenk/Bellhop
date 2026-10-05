import { z } from 'zod';
import type { BridgeAddress } from './mid-suggest.ts';

// Parsers for the `pvesh ... --output-format json` answers the setup
// walkthrough reads from a host it is adding (issue #86, research R7/R8).
// Each is validated with zod: a host that answers with something else is
// reported, not guessed at.

const VersionSchema = z.object({ version: z.string().min(1) });

const ClusterStatusSchema = z.array(
  z.object({
    type: z.string(),
    name: z.string().optional(),
    ip: z.string().optional(),
    local: z.number().optional(),
  })
);

const NetworkSchema = z.array(
  z.object({
    iface: z.string(),
    type: z.string(),
    active: z.number().optional(),
    address: z.string().optional(),
    cidr: z.string().optional(),
    gateway: z.string().optional(),
  })
);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// `pvesh get /version`: the Proxmox VE version, which also proves the host is
// a Proxmox node.
export function parseVersion(text: string): string {
  const parsed = VersionSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new Error('the host did not answer like a Proxmox node (pvesh get /version)');
  return parsed.data.version;
}

export interface ClusterPeer {
  name: string;
  address: string;
}

// `pvesh get /cluster/status`: the cluster's other nodes. A standalone node
// reports only itself, so it has no peers.
export function clusterPeers(text: string): ClusterPeer[] {
  const parsed = ClusterStatusSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new Error('could not read the cluster status (pvesh get /cluster/status)');
  return parsed.data.flatMap((e) =>
    e.type === 'node' && !e.local && e.name && e.ip ? [{ name: e.name, address: e.ip }] : []
  );
}

// `pvesh get /nodes/<node>/network`: the host's own address on its main
// bridge: an active bridge carrying an IPv4 address and a gateway, else any
// such bridge. Undefined when none has both (no midScheme suggestion).
export function primaryBridgeAddress(text: string): BridgeAddress | undefined {
  const parsed = NetworkSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new Error('could not read the network configuration (pvesh get /nodes/<node>/network)');
  const bridges = parsed.data.filter((i) => i.type === 'bridge' && i.address && i.cidr && i.gateway);
  const best = bridges.find((b) => b.active) ?? bridges[0];
  if (!best?.address || !best.cidr || !best.gateway) return undefined;
  const prefixLength = Number(best.cidr.split('/')[1]);
  if (!Number.isInteger(prefixLength)) return undefined;
  return { address: best.address, prefixLength, gateway: best.gateway };
}
