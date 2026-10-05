import express from 'express';
import { refreshInventory } from '../lib/inventory.ts';
import { invalidateConfigSnapshot } from '../lib/config.ts';
import type { Inventory } from '../lib/inventory.ts';
import type { SSHClient } from '../lib/ssh-client.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';
import type { CloudflareClient } from '../lib/cloudflare-client.ts';
import { UnconfiguredCloudflareClient } from '../lib/cloudflare-client.ts';
import type { GoBuilder } from '../lib/go-build.ts';
import type { JobStore } from './jobs/job-store.ts';
import type { JobLog } from './jobs/job-log.ts';
import type { JobRunner } from './jobs/job-runner.ts';
import type { TaskScheduler } from './tasks/scheduler.ts';
import { requireAuth } from './auth.ts';
import { applyImpersonation, type ImpersonationStore } from './impersonation.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { appUpdatesRoutes } from './routes/app-updates.ts';
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
import { oidcRoutes } from './routes/oidc.ts';
import { tasksRoutes } from './routes/tasks.ts';
import { authRoutes } from './routes/auth.ts';
import { SessionStore } from './login/session-store.ts';
import { SessionService } from './login/sessions.ts';
import { RealWebLoginClient, type WebLoginClient } from './login/oidc-client.ts';
import { buildMcpHttp } from './mcp/index.ts';
import { McpAuthStore } from './mcp/auth-store.ts';

export interface AppDeps {
  inventory: Inventory;
  baseSsh: SSHClient;
  jobStore: JobStore;
  jobLog: JobLog;
  jobRunner: JobRunner;
  inventoryPath: string;
  authentik: AuthentikClient;
  // Used only by syncProxyLive's stale _acme-challenge prune (issue #162).
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
  // The daily-task scheduler (issue #61). server.ts always passes the one
  // it started; optional so tests that don't care need no changes, and the
  // /api/tasks routes answer 503 when it's absent.
  taskScheduler?: TaskScheduler;
  // Bellhop's own web-login sessions (#69). server.ts passes one backed by
  // data/sessions.sqlite3, and hands the same instance to
  // attachJobsWebSocket so the job-log socket resolves cookies identically.
  // Defaulted to an in-memory store so tests that do not sign anyone in need
  // no changes; tests that do pass test/support/web-session.ts's service.
  sessions?: SessionService;
  // The provider client for sign-in and re-checks, used only when
  // `sessions` is not given (the default service is built around it); a
  // test can inject a fake here.
  webLogin?: WebLoginClient;
  // The MCP authorization server's clients, codes, grants and tokens
  // (#65/#66). server.ts passes one backed by data/sessions.sqlite3;
  // defaulted to an in-memory store for tests that don't sign MCP clients in.
  mcpAuthStore?: McpAuthStore;
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  const impersonationStore: ImpersonationStore = deps.impersonationStore ?? new Map();
  const cloudflare: CloudflareClient = deps.cloudflare ?? new UnconfiguredCloudflareClient();
  const sessions: SessionService =
    deps.sessions ??
    new SessionService({ store: new SessionStore(':memory:'), client: deps.webLogin ?? new RealWebLoginClient() });
  app.use(express.json());
  // Drop the config accessor's snapshot at the start of every /api request
  // (issue #64, research R3), so a setting saved by another process (the
  // CLI, the MCP server, a direct DB edit) applies on this very request
  // rather than up to the snapshot's TTL later. It runs ahead of
  // requireAuth, not beside refreshInventory below, because requireAuth
  // itself reads settings (webUiAuthMode, the admin group names). Sign-in
  // reads the OIDC settings, so /auth gets the same fresh read.
  // /mcp and the MCP authorization server's paths (#65/#66) read the API
  // key and the web-login settings too.
  app.use(['/api', '/auth', '/mcp', '/.well-known', '/register', '/authorize', '/token', '/revoke'], (_req, _res, next) => {
    invalidateConfigSnapshot();
    next();
  });
  // MCP over HTTP (#65/#66), ahead of requireAuth: it authenticates with its
  // own bearer credential, never the session cookie. Its jobs run on this
  // service's JobRunner, so they are owned by 'web'.
  const mcpHttp = buildMcpHttp({
    sessions,
    authStore: deps.mcpAuthStore ?? new McpAuthStore(':memory:'),
    mcp: {
      ssh: deps.baseSsh,
      inventory: deps.inventory,
      inventoryPath: deps.inventoryPath,
      authentik: deps.authentik,
      cloudflare,
      goBuilder: deps.goBuilder,
      fetchImpl: deps.fetchImpl,
      tlsProbeSleepFn: deps.tlsProbeSleepFn,
      jobStore: deps.jobStore,
      jobLog: deps.jobLog,
      jobRunner: deps.jobRunner,
    },
  });
  // The /auth routes, ahead of requireAuth: signing in must never need a
  // session (#69, contracts/http-auth.md). An MCP sign-in's consent step
  // lives under it, and its callback finishes through mcpHttp.signIn.
  app.use('/auth/mcp', mcpHttp.consentRouter);
  app.use('/auth', authRoutes(sessions, mcpHttp.signIn));
  app.use(mcpHttp.router);
  app.use(requireAuth(sessions));
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
  app.use('/api', dashboardRoutes(deps.inventory, deps.inventoryPath, deps.baseSsh, deps.authentik, cloudflare, deps.fetchImpl));
  app.use('/api/app-updates', appUpdatesRoutes(deps.inventory, deps.inventoryPath));
  app.use('/api/jobs', jobsRoutes(deps.jobStore, deps.jobLog, deps.jobRunner, deps.inventoryPath, deps.inventory));
  app.use(
    '/api/provisioning',
    provisioningRoutes(deps.inventory, deps.baseSsh, deps.jobRunner, deps.inventoryPath, deps.authentik, cloudflare, {
      goBuilder: deps.goBuilder,
      fetchImpl: deps.fetchImpl,
      tlsProbeSleepFn: deps.tlsProbeSleepFn,
    })
  );
  app.use(
    '/api/maintenance',
    maintenanceRoutes(deps.inventory, deps.baseSsh, deps.jobRunner, deps.inventoryPath, deps.authentik, cloudflare, {
      fetchImpl: deps.fetchImpl,
    })
  );
  app.use('/api/users', usersRoutes(deps.authentik));
  app.use('/api/groups', groupsRoutes(deps.authentik));
  app.use('/api/auth-groups', authGroupsRoutes(deps.authentik));
  app.use('/api/permissions', permissionsRoutes(deps.inventoryPath));
  app.use('/api/settings', settingsRoutes(deps.inventory, deps.inventoryPath));
  app.use('/api/impersonate', impersonationRoutes(deps.authentik, impersonationStore));
  app.use('/api/networking', networkingRoutes(deps.inventory, deps.inventoryPath, deps.fetchImpl));
  app.use(
    '/api/oidc',
    oidcRoutes(deps.inventory, deps.inventoryPath, deps.baseSsh, deps.authentik, cloudflare, deps.jobRunner)
  );
  app.use('/api/tasks', tasksRoutes(deps.taskScheduler));
  return app;
}
