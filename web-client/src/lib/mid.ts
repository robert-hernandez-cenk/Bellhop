import type { HostEntry, GuestEntry } from '../api/types.ts';

export const MID_MIN = 2;
export const MID_MAX = 252;

function baseVmidFor(host: HostEntry): number | null {
  return host.midScheme?.vmidBase ?? null;
}

export function vmidForMid(host: HostEntry | undefined, mid: number): number | null {
  if (!host || !Number.isInteger(mid)) return null;
  const base = baseVmidFor(host);
  return base === null ? null : base + mid;
}

// usedMids is the host's occupied-MID list from GET /provisioning/used-mids
// (issue #54): computed server-side from the full inventory, so it counts
// guests the signed-in user can't see. Undefined means "not known" (still
// loading, or the load failed), and then nothing is suggested rather than
// falling back to the user's filtered guest list.
export function nextAvailableMid(host: HostEntry | undefined, usedMids: number[] | undefined): number | null {
  if (!host || usedMids === undefined) return null;
  if (baseVmidFor(host) === null) return null;
  const used = new Set(usedMids);
  for (let mid = MID_MIN; mid <= MID_MAX; mid++) {
    if (!used.has(mid)) return mid;
  }
  return null;
}

export function isMidUsed(usedMids: number[] | undefined, mid: number): boolean {
  return usedMids !== undefined && usedMids.includes(mid);
}

// The MID field's on-blur warning (issue #54). Occupancy comes from usedMids
// (the full inventory), but a guest is only ever named when the signed-in
// user can already see it in visibleGuests -- otherwise the warning says the
// MID is taken without saying by what.
export function midCollisionMessage(
  host: HostEntry | undefined,
  mid: string,
  usedMids: number[] | undefined,
  visibleGuests: GuestEntry[],
): string | null {
  if (!host || mid.trim() === '') return null;
  const n = Number(mid);
  const vmid = vmidForMid(host, n);
  if (vmid === null || !isMidUsed(usedMids, n)) return null;
  const holder = visibleGuests.find((g) => g.host === host.name && g.vmid === vmid);
  return holder
    ? `MID ${n} is already used by ${holder.name} (vmid ${holder.vmid}) on ${host.name}.`
    : `MID ${n} is already in use on ${host.name}.`;
}
