import path from 'node:path';
import dotenv from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authentikConfig } from '../lib/authentik-config.ts';
import { loadInventory } from '../lib/inventory.ts';
import { Ssh2SSHClient } from '../lib/ssh-client.ts';
import { buildAuthentikClient } from '../lib/authentik-client.ts';
import { buildCloudflareClient } from '../lib/cloudflare-client.ts';
import { dataDir, inventoryPath } from '../lib/paths.ts';
import { JobStore } from '../web/jobs/job-store.ts';
import { createJobLog } from '../web/jobs/job-log.ts';
import { JobRunner } from '../web/jobs/job-runner.ts';
import { buildMcpServer } from './build-server.ts';

// MCP stdio entry point (#16). stdout is the protocol channel, so any
// console.log outside a job's captured console (a command's dry-run notice,
// a stray log line) must go to stderr instead. withCapturedConsole saves and
// restores whatever console.log is at call time, so this redirect survives it.
console.log = console.error;

// Same ordering as src/web/server.ts: authentik.env must be loaded before
// loadInventory, because the requires_auth -> auth_group migration reads
// AUTHENTIK_GROUP_LADDER at DB-open time.
dotenv.config({ path: path.join(dataDir(), 'authentik.env'), quiet: true });
// CLOUDFLARE_DNS_API_TOKEN for the stale _acme-challenge prune (#162) that
// syncCaddyLive runs after a guest edit or provisioning apply -- same file
// src/web/server.ts and src/cli.ts load. A missing file leaves the prune
// skipped, never failing the operation.
dotenv.config({ path: path.join(dataDir(), 'cloudflare-api.env'), quiet: true });

// Deliberately this checkout's own inventory and data dir (paths.ts), like
// the web service: whichever checkout runs the server is the one it manages.
const invPath = inventoryPath();
const inventory = loadInventory(invPath);
authentikConfig();

const baseSsh = new Ssh2SSHClient();
const jobStore = new JobStore(path.join(dataDir(), 'jobs.sqlite3'));
const jobLog = createJobLog(path.join(dataDir(), 'job-logs'));
const jobRunner = new JobRunner(jobStore, jobLog, baseSsh, { owner: `mcp:${process.pid}` });
// Owner-scoped: closes this process's leftovers and dead MCP processes'
// rows, never the web service's live jobs.
jobRunner.reconcileOrphanedJobs();

const server = buildMcpServer({
  ssh: baseSsh,
  inventory,
  inventoryPath: invPath,
  authentik: buildAuthentikClient(),
  cloudflare: buildCloudflareClient(),
  jobStore,
  jobLog,
  jobRunner,
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await jobRunner.shutdown(5000);
  await server.close();
  jobStore.close();
  process.exit(0);
}

// The client closing stdin is how a session ending reaches a stdio server;
// the signals cover a manual Ctrl+C when run by hand.
process.stdin.on('close', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());
console.error(`bellhop MCP server ready (inventory: ${invPath})`);
