import type { HostEntry, GuestEntry } from '../api/types';

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

export function nextAvailableMid(host: HostEntry | undefined, guests: GuestEntry[]): number | null {
  if (!host) return null;
  const base = baseVmidFor(host);
  if (base === null) return null;
  const usedMids = new Set(
    guests
      .filter((g) => g.host === host.name)
      .map((g) => g.vmid - base)
      .filter((mid) => mid >= MID_MIN && mid <= MID_MAX)
  );
  for (let mid = MID_MIN; mid <= MID_MAX; mid++) {
    if (!usedMids.has(mid)) return mid;
  }
  return null;
}
