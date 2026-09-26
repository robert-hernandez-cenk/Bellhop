# Contract: Proxy driver interface (`src/lib/proxy/`)

Internal TypeScript contract between the proxy-neutral core and a driver.

## routes.ts

```ts
export type PathPattern = { kind: 'exact'; path: string } | { kind: 'prefix'; path: string };

export type ProxyAuth =
  | { mode: 'ungated' }
  | { mode: 'oidc' }
  | { mode: 'forward'; exemptPaths: PathPattern[]; rawExemptPaths: string[] };

export interface ProxyRoute {
  owner: { type: 'host' | 'guest' | 'externalSite'; name: string };
  hostnames: string[];
  backend: { ip: string; port: number; insecureTls: boolean };
  auth: ProxyAuth;
}

export interface ProxyContext {
  outpost?: { ip: string; port: number };
  externalPort: number; // 443
}

export function parsePathPattern(raw: string): PathPattern;          // throws on an invalid pattern
export function buildRoutes(inventory: Inventory): ProxyRoute[];      // throws the missing-authentik error
export function buildProxyContext(inventory: Inventory): ProxyContext;
```

`rawExemptPaths` carries the stored strings in stored order, so a driver
that already accepts them verbatim (Caddy) renders byte-identical output
without reconstructing them from `exemptPaths`.

## driver.ts

```ts
export type ProxyAuthMode = 'forward' | 'oidc';

export interface DriverCapabilities {
  authModes: ProxyAuthMode[];
  acmeDns01ViaCloudflare: boolean;
}

export interface DriverDeps {
  ssh: SSHClient;
  inventory: Inventory;
  proxyHost: string;     // name of the proxy: true entry
  configPath: string;    // inventory.proxyConfigPath ?? driver.defaultConfigPath
}

export interface ProxyPlan { preview: string; payload: unknown }

export interface ReverseProxyDriver {
  id: ProxyDriverId;
  capabilities: DriverCapabilities;
  defaultConfigPath: string;
  plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan>;
  apply(plan: ProxyPlan, deps: DriverDeps): Promise<void>;     // throws on failure
  snapshot(deps: DriverDeps): Promise<string>;                  // throws on failure
}

export interface CapabilityError { owner: ProxyRoute['owner']; mode: ProxyAuthMode; message: string }
export function checkCapabilities(routes: ProxyRoute[], driver: ReverseProxyDriver): CapabilityError[];
```

Capability error message (one per offending route):

```text
Entry '<name>' uses <forward-auth|OIDC> gating, but the '<driver-id>' proxy driver cannot enforce it -- set its authMode to <oidc|forward> or clear authGroup
```

`sync-proxy` joins all messages into one thrown `Error`. `commitGuestEdit`
returns the edited entry's message as a 400.

## file-driver.ts

```ts
export interface FileSpec { path: string; content: string; mode: 'owned' | 'managed-section' }

export function fileDriver(def: {
  id: ProxyDriverId;
  capabilities: DriverCapabilities;
  defaultConfigPath: string;
  render(routes: ProxyRoute[], ctx: ProxyContext, configPath: string): FileSpec[];
  validateCommand(configPath: string): string;
  reloadCommand: string;
}): ReverseProxyDriver;

export function buildFileDriverScript(files: FileSpec[], validateCommand: string, reloadCommand: string): string;
```

Behaviour of the generated POSIX `sh` script, run on the proxy host via
`runRemote`:

1. `set -e`; for each file, copy it to a backup (or record that it did not
   exist).
2. Write each file: `owned` replaces it; `managed-section` removes any
   existing `# BEGIN bellhop-managed`…`# END bellhop-managed` block and
   appends the new block (creating the file if absent).
3. Run the validate command. On failure: restore every backup (removing
   files that did not exist before), print `<validate> failed; restored
   previous configuration` to stderr, exit 1.
4. Remove backups, run the reload command.

- `plan()` → `{ preview: files.map(content).join('\n'), payload: files }`
  (single file: the content alone, so the Caddy preview equals today's).
- `apply()` → `runRemote(ssh, inventory, proxyHost, script)`; non-zero exit
  throws with stderr.
- `snapshot()` → `cat` of each file; more than one file gets a
  `==> <path> <==` header per file.

## index.ts

```ts
export const PROXY_DRIVER_IDS = ['caddy'] as const;
export type ProxyDriverId = (typeof PROXY_DRIVER_IDS)[number];

export function getDriver(inventory: Inventory): ReverseProxyDriver;   // proxyDriver ?? 'caddy'
export function driverDeps(inventory: Inventory, ssh: SSHClient, driver: ReverseProxyDriver): DriverDeps;
                                                                       // throws "No inventory entry has 'proxy: true'"
```

Unknown id (only reachable if the DB was edited by hand, since the schema
rejects it): `Unknown proxyDriver '<id>' -- run: bellhop set-config
proxyDriver <caddy> --apply`.

## drivers/caddy.ts

`caddyDriver = fileDriver({ id: 'caddy', capabilities: { authModes:
['forward','oidc'], acmeDns01ViaCloudflare: true }, defaultConfigPath:
'/etc/caddy/Caddyfile', render, validateCommand: p => \`caddy validate
--adapter caddyfile --config ${quoted p}\`, reloadCommand: 'systemctl reload
caddy' })`.

`render` produces one `managed-section` FileSpec whose content is exactly
today's `buildCaddyBlock` output for the same inventory.

## Consumers

| Caller | Uses |
|---|---|
| `runSyncProxy` | `getDriver`, `driverDeps`, `buildRoutes`, `buildProxyContext`, `checkCapabilities`, `plan`, `apply` |
| `syncProxyLive` | `runSyncProxy`; `capabilities.acmeDns01ViaCloudflare` for the prune |
| `runRenderStatusPage` | `getDriver`, `driverDeps`, `snapshot` |
| `commitGuestEdit` | `getDriver`, `buildRoutes` (on the edited inventory), `checkCapabilities` filtered to the edited guest |
| `sync-authentik`, `adopt-oidc-client`, `buildRoutes` | `publicHostname` (`src/lib/hostname.ts`) |
