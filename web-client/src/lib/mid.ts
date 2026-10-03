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
  if (vmid === null) return null;
  const holder = visibleGuests.find((g) => g.host === host.name && g.vmid === vmid);
  // With usedMids unknown (pending or failed to load), a visible guest
  // holding the MID still warns; only the hidden-guest case needs usedMids.
  if (!isMidUsed(usedMids, n) && !holder) return null;
  return holder
    ? `MID ${n} is already used by ${holder.name} (vmid ${holder.vmid}) on ${host.name}.`
    : `MID ${n} is already in use on ${host.name}.`;
}

// The default a mid field gets for the selected target host (issue #54).
// With a guest selected (migrate-guest), its own MID is kept unless it is
// already taken on the target host; once the target host is known but its
// occupied list isn't (pending or failed), nothing is guessed (FR-008).
// Without a guest, it is the next free MID on the host, or '' if none.
export function midFieldDefault(
  host: HostEntry | undefined,
  guest: GuestEntry | undefined,
  usedMids: number[] | undefined,
): string {
  if (guest) {
    const preferredMid = guest.vmid % 1000;
    if (host?.midScheme === undefined) return String(preferredMid);
    if (usedMids === undefined) return '';
    if (!isMidUsed(usedMids, preferredMid)) return String(preferredMid);
  }
  const suggested = nextAvailableMid(host, usedMids);
  return suggested === null ? '' : String(suggested);
}
