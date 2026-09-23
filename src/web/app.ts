import express from 'express';
import { refreshInventory } from '../lib/inventory.ts';
import type { Inventory } from '../lib/inventory.ts';
import type { SSHClient } from '../lib/ssh-client.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';
import type { CloudflareClient } from '../lib/cloudflare-client.ts';
import { UnconfiguredCloudflareClient } from '../lib/cloudflare-client.ts';
import type { GoBuilder } from '../lib/go-build.ts';
import type { JobStore } from './jobs/job-store.ts';
import type { JobLog } from './jobs/job-log.ts';
import type { JobRunner } from './jobs/job-runner.ts';
import { requireAuth } from './auth.ts';
import { applyImpersonation, type ImpersonationStore } from './impersonation.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { jobsRoutes } from './routes/jobs.ts';
import { provisioningRoutes } from './routes/provisioning.ts';
import { maintenanceRoutes } from './routes/maintenance.ts';
import { usersRoutes } from './routes/users.ts';
import { groupsRoutes } from './routes/groups.ts';
import { authGroupsRoutes } from './routes/auth-groups.ts';
import { permissionsRoutes } from './routes/permissions.ts';
import { settingsRoutes } from './routes/settings.ts';
import { impersonationRoutes } from './routes/impersonation.ts';
import { networkingRoutes } from './routes/networking.ts';

export interface AppDeps {
  inventory: Inventory;
  baseSsh: SSHClient;
  jobStore: JobStore;
  jobLog: JobLog;
  jobRunner: JobRunner;
  inventoryPath: string;
  authentik: AuthentikClient;
  // Used only by syncCaddyLive's stale _acme-challenge prune (issue #162).
  // Optional and defaulted to unconfigured below, same as impersonationStore,
  // so tests that don't care about Cloudflare need no changes. server.ts
  // always passes buildCloudflareClient()'s result.
  cloudflare?: CloudflareClient;
  // Shared with attachJobsWebSocket in server.ts -- both must read/write the
  // same store instance so WS job-visibility filtering matches the REST
  // view during impersonation. Optional and defaulted here so tests that
  // don't care about impersonation need no changes.
  impersonationStore?: ImpersonationStore;
  // Test-only injection point for deploy-vpn-gateway's Go cross-compile and
  // NordVPN/PIA API calls -- unset in production (server.ts never passes
  // these), so runDeployVpnGateway falls back to its own real
  // LocalGoBuilder/global fetch defaults exactly as it always has.
  goBuilder?: GoBuilder;
  fetchImpl?: typeof fetch;
  // Test-only injection point for tls-probe.ts's retry-loop sleep, so a
  // test exercising create-lxc/create-vm/install-app's create-time probe
  // retries doesn't have to wait ~3 real minutes. Unset in production
  // (server.ts never passes it), so probeInsecureBackendTls falls back to
  // its own real setTimeout-based sleep exactly as it always has.
  tlsProbeSleepFn?: (ms: number) => Promise<void>;
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  const impersonationStore: ImpersonationStore = deps.impersonationStore ?? new Map();
  const cloudflare: CloudflareClient = deps.cloudflare ?? new UnconfiguredCloudflareClient();
  app.use(express.json());
  app.use(requireAuth);
  app.use(applyImpersonation(impersonationStore));
  // Reload inventory from disk before every /api request so a change
  // written by another process (a direct DB edit, a CLI command, a
  // hand-edit) is visible immediately instead of only after a service
  // restart (issue #98). Mutates deps.inventory in place -- every route
  // module below was handed this exact object reference and reads it via
  // property access inside its handlers, so this refresh is transparent
  // to all of them.
  app.use('/api', (req, res, next) => {
    refreshInventory(deps.inventory, deps.inventoryPath);
    next();
  });
  app.use('/api', dashboardRoutes(deps.inventory, deps.inventoryPath, deps.baseSsh, deps.authentik, cloudflare));
  app.use('/api/jobs', jobsRoutes(deps.jobStore, deps.jobLog, deps.jobRunner, deps.inventoryPath));
  app.use(
    '/api/provisioning',
    provisioningRoutes(deps.inventory, deps.baseSsh, deps.jobRunner, deps.inventoryPath, deps.authentik, cloudflare, {
      goBuilder: deps.goBuilder,
      fetchImpl: deps.fetchImpl,
      tlsProbeSleepFn: deps.tlsProbeSleepFn,
    })
  );
  app.use('/api/maintenance', maintenanceRoutes(deps.inventory, deps.baseSsh, deps.jobRunner, deps.inventoryPath, deps.authentik, cloudflare));
  app.use('/api/users', usersRoutes(deps.authentik));
  app.use('/api/groups', groupsRoutes(deps.authentik));
  app.use('/api/auth-groups', authGroupsRoutes(deps.authentik));
  app.use('/api/permissions', permissionsRoutes(deps.inventoryPath));
  app.use('/api/settings', settingsRoutes(deps.inventory, deps.inventoryPath));
  app.use('/api/impersonate', impersonationRoutes(deps.authentik, impersonationStore));
  app.use('/api/networking', networkingRoutes(deps.inventory, deps.inventoryPath));
  return app;
}
