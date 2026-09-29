// Dependency-free on purpose: src/lib/proxy/driver.ts, src/lib/proxy/
// index.ts's driver registry, and src/lib/inventory.ts's proxyDriver enum
// all need these ids, and none should have to import another to get them.
// 'caddy' and 'nginx' ship today; a new driver adds its id here.
export const PROXY_DRIVER_IDS = ['caddy', 'nginx'] as const;
export type ProxyDriverId = (typeof PROXY_DRIVER_IDS)[number];
