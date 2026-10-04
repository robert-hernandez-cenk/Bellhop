import http from 'node:http';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { authentikConfig } from '../lib/authentik-config.ts';
import { loadInventory } from '../lib/inventory.ts';
import { Ssh2SSHClient } from '../lib/ssh-client.ts';
import { buildAuthentikClient } from '../lib/authentik-client.ts';
import { buildCloudflareClient } from '../lib/cloudflare-client.ts';
import { authMode } from './auth.ts';
import { logWarn } from '../lib/log.ts';
import type { ImpersonationStore } from './impersonation.ts';
import { JobStore } from './jobs/job-store.ts';
import { createJobLog } from './jobs/job-log.ts';
import { JobRunner } from './jobs/job-runner.ts';
import { TaskScheduler } from './tasks/scheduler.ts';
import { buildApp } from './app.ts';
import { attachJobsWebSocket } from './routes/jobs.ts';
import { REPO_ROOT, dataDir, inventoryPath } from '../lib/paths.ts';

// AUTHENTIK_API_URL/AUTHENTIK_API_TOKEN are loaded from a gitignored file
// rather than a real system/service-level env var -- the Windows service
// (scripts/windows-service.ts's buildService()) only sets PORT/USERPROFILE,
// so without this there was no way to hand it these two values at all.
// Silent no-op if missing: buildAuthentikClient() below falls back to
// UnconfiguredAuthentikClient when the file doesn't exist yet.
// Loaded before loadInventory() below because the one-time requires_auth ->
// auth_group migration (src/lib/inventory.ts) reads AUTHENTIK_GROUP_LADDER
// at DB-open time; with the old ordering it would silently see the built-in
// default instead of this operator's configured ladder.
dotenv.config({ path: path.join(dataDir(), 'authentik.env'), quiet: true });

// CLOUDFLARE_DNS_API_TOKEN for syncProxyLive's stale _acme-challenge prune
// (issue #162), loaded the same way and for the same reason as
// authentik.env. Not data/cloudflare.env, which is the cloudflare-ddns
// container's answer file. Silent no-op if missing: buildCloudflareClient()
// falls back to UnconfiguredCloudflareClient and the prune is skipped.
dotenv.config({ path: path.join(dataDir(), 'cloudflare-api.env'), quiet: true });

// NPM_API_EMAIL/NPM_API_PASSWORD (and optionally NPM_API_URL) for the
// nginx-proxy-manager proxy driver (issue #31), loaded the same way and for
// the same reason as the two files above. Silent no-op if missing --
// buildNpmClient() throws its own named error only once a sync actually
// tries to reach NPM.
dotenv.config({ path: path.join(dataDir(), 'nginx-proxy-manager.env'), quiet: true });

const invPath = inventoryPath();
const inventory = loadInventory(invPath);

// Called at boot so an invalid WEB_UI_AUTH_MODE fails fast here rather than
// on every request. The warning is one of the two visible guards on the
// inferred default -- the other is the web UI's own banner.
const mode = authMode();
if (mode !== 'authentik') {
  logWarn(
    `Web UI auth mode is '${mode}': requests with no Authentik forward-auth headers are served as a full-admin local operator. ` +
      'Set WEB_UI_AUTH_MODE=authentik to require authentication.'
  );
}

// authentikConfig() throws on a malformed AUTHENTIK_OUTPOST_PORT (see its
// own comment in src/lib/authentik-config.ts). It's now reached from
// isAdminUser -> resolveAuthUser / localOperator() / isJobVisible on every
// request -- worst case, the raw 'upgrade' WebSocket listener in
// src/web/routes/jobs.ts, which has no Express error handling, so an
// uncaught throw there would be an unhandled exception that could take the
// whole process down. Calling it here, right alongside the authMode() boot
// check above, makes a bad value fail fast at startup with a clear message
// instead.
authentikConfig();

const baseSsh = new Ssh2SSHClient();
const jobStore = new JobStore(path.join(dataDir(), 'jobs.sqlite3'));
const jobLog = createJobLog(path.join(dataDir(), 'job-logs'));
const jobRunner = new JobRunner(jobStore, jobLog, baseSsh);
// Close out any job left running/queued/awaiting_input by a previous
// process that died mid-job (e.g. a service restart) -- see issue #99 and
// JobRunner.reconcileOrphanedJobs. Must run before the app starts
// accepting requests, so no client can observe a stale non-terminal
// status this process never actually owns.
jobRunner.reconcileOrphanedJobs();

// Scheduled tasks (issue #61): the daily check-app-updates run. Started only
// here -- never by the MCP server or CLI (FR-006) -- and only after
// reconcileOrphanedJobs() above, so a run a previous process left
// "running" is already interrupted and can't block today's catch-up run.
// start() ticks once immediately, so a run missed while the service was
// down starts within seconds (FR-003).
const taskScheduler = new TaskScheduler({ inventory, inventoryPath: invPath, jobRunner, jobStore });
taskScheduler.start();
// The ticker is unref'd, so it never holds the process open on its own;
// stopping it on exit just keeps shutdown explicit. This process has no
// other graceful-shutdown handling to hook into.
process.on('exit', () => taskScheduler.stop());

const authentik = buildAuthentikClient();
const impersonationStore: ImpersonationStore = new Map();
const app = buildApp({
  inventory,
  baseSsh,
  jobStore,
  jobLog,
  jobRunner,
  inventoryPath: invPath,
  authentik,
  cloudflare: buildCloudflareClient(),
  impersonationStore,
  taskScheduler,
});

const clientDist = path.join(REPO_ROOT, 'web-client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = http.createServer(app);
attachJobsWebSocket(server, jobRunner, jobStore, jobLog, invPath, inventory, impersonationStore);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`bellhop web UI listening on http://localhost:${port}`);
});
