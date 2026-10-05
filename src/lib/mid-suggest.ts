import type { HostEntry, MidScheme } from './inventory.ts';

// The host's own address on its main bridge, as read from Proxmox
// (pve-discovery.ts's primaryBridgeAddress).
export interface BridgeAddress {
  address: string;
  prefixLength: number;
  gateway: string;
}

const VMID_BASE_STEP = 1000;

// The setup walkthrough's midScheme suggestion for a newly added host
// (issue #86, research R8). A starting point the operator edits, never
// saved without them:
// - ipPrefix: the host's own first three octets. validateInventory refuses
//   two hosts sharing a prefix, so in a network wider than /24 a taken
//   prefix moves to the next free third octet inside the same network; a
//   /24 has no other prefix to offer, so the clash is left for the save to
//   name.
// - vmidBase: VMIDs are cluster-wide and a MID spans 2-252, so bases sit a
//   thousand apart, starting at 1000 (Proxmox needs VMIDs >= 100).
export function suggestMidScheme(bridge: BridgeAddress | undefined, otherHosts: HostEntry[]): MidScheme | undefined {
  if (!bridge) return undefined;
  const octets = bridge.address.split('.').map(Number);
  const takenPrefixes = new Set(otherHosts.flatMap((h) => (h.midScheme ? [h.midScheme.ipPrefix] : [])));
  const takenBases = new Set(otherHosts.flatMap((h) => (h.midScheme ? [h.midScheme.vmidBase] : [])));

  let third = octets[2];
  const prefixFor = (n: number) => `${octets[0]}.${octets[1]}.${n}.`;
  if (takenPrefixes.has(prefixFor(third)) && bridge.prefixLength < 24) {
    // The third octets this network spans: e.g. a /22 covers four.
    const span = 2 ** (24 - Math.max(bridge.prefixLength, 16));
    const first = third - (third % span);
    for (let n = first; n < first + span; n++) {
      if (!takenPrefixes.has(prefixFor(n))) {
        third = n;
        break;
      }
    }
  }

  let vmidBase = VMID_BASE_STEP;
  while (takenBases.has(vmidBase)) vmidBase += VMID_BASE_STEP;

  return { vmidBase, ipPrefix: prefixFor(third), cidrSuffix: bridge.prefixLength, gateway: bridge.gateway };
}
