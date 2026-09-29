// Dependency-free on purpose: src/lib/proxy/driver.ts, src/lib/proxy/
// index.ts's driver registry, and src/lib/inventory.ts's proxyDriver enum
// all need these ids, and none should have to import another to get them.
// 'caddy' and 'nginx' are the file-configured drivers that ship today
// (nginx: issue #30); 'none' (issue #33) is a real registered driver too --
// it means Bellhop manages no reverse proxy, not that no proxy exists in
// front of the deployment. A future driver adds its id here.
export const PROXY_DRIVER_IDS = ['caddy', 'nginx', 'none'] as const;
export type ProxyDriverId = (typeof PROXY_DRIVER_IDS)[number];

// The id of the driver that means "Bellhop manages no reverse proxy" --
// managesProxy() in ./driver.ts compares against this, and nothing else
// should compare against the bare literal.
export const NO_PROXY_DRIVER_ID: ProxyDriverId = 'none';
