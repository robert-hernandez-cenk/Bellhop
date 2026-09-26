// Dependency-free on purpose: src/lib/proxy/driver.ts (and, in a later
// batch, src/lib/proxy/index.ts's driver registry) both need ProxyDriverId,
// and neither should have to import the other to get it. Only 'caddy' ships
// this round -- a follow-up driver (issue tracked per research.md R4)
// extends this list.
export const PROXY_DRIVER_IDS = ['caddy'] as const;
export type ProxyDriverId = (typeof PROXY_DRIVER_IDS)[number];
