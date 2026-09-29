// Runs the real web UI (buildApp, the same app src/web/server.ts serves)
// against the example-only demo inventory, with every outside dependency
// replaced: a DemoSSHClient instead of ssh2, a fixed catalog instead of
// GitHub, and unconfigured Authentik/Cloudflare clients. Everything it
// writes goes to a fresh temp directory that close() removes. See
// specs/014-web-ui-screenshots/research.md R1, R4 and R9.
//
// Deliberately NOT modeled on server.ts's module-level startup: that file
// dotenv-loads data/*.env and resolves inventoryPath()/dataDir() from the
// checkout. This one never loads a dotenv file and takes every path from its
// own temp directory.
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import type { GoBuilder } from '../../src/lib/go-build.ts';
import { REPO_ROOT } from '../../src/lib/paths.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { buildApp } from '../../src/web/app.ts';
import { attachJobsWebSocket } from '../../src/web/routes/jobs.ts';
import type { ImpersonationStore } from '../../src/web/impersonation.ts';
import { buildDemoInventory } from './demo-inventory.ts';
import { DemoSSHClient } from './demo-ssh.ts';
import { demoFetch } from './demo-fetch.ts';
import { seedDemoJobs } from './demo-jobs.ts';

export interface StartDemoServerOptions {
  // 0 lets the OS pick a free port (the screenshot capture script does this).
  port: number;
  // Serve the built web client (web-client/dist) with the same SPA fallback
  // as server.ts. The API test turns this off, since it needs no build.
  serveClient?: boolean;
}

export interface DemoServer {
  url: string;
  port: number;
  dir: string;
  inventoryPath: string;
  close(): Promise<void>;
}

// The identity a reverse proxy's Authentik forward-auth would add for a
// signed-in admin (research R4). With these present, the Sidebar shows a
// normal signed-in admin instead of the "no authentication configured"
// warning a real header-less deployment deserves.
const DEMO_IDENTITY_HEADERS = {
  'x-authentik-username': 'admin',
  'x-authentik-email': 'admin@example.com',
  'x-authentik-groups': 'bellhop-admins',
} as const;

function setDemoIdentity(headers: IncomingHttpHeaders): void {
  Object.assign(headers, DEMO_IDENTITY_HEADERS);
}

// Makes the demo independent of the developer's environment (FR-006): strict
// header auth (so the headers above are the only identity), no dev-user
// bypass, default Authentik group names, and the path resolvers pointed at
// the temp directory in case anything ever calls inventoryPath()/dataDir().
// Mutating process.env is intended -- the demo owns its process.
function isolateEnvironment(inventoryPath: string, dataDir: string): void {
  process.env.WEB_UI_AUTH_MODE = 'authentik';
  process.env.INVENTORY_FILE = inventoryPath;
  process.env.WEB_DATA_DIR = dataDir;
  delete process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_GROUPS;
  delete process.env.WEB_UI_LOCAL_USER;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AUTHENTIK_')) delete process.env[key];
  }
}

// deploy-vpn-gateway cross-compiles its agent with the real `go` toolchain;
// the demo hands it placeholder bytes instead, which DemoSSHClient.putFile
// then discards.
const demoGoBuilder: GoBuilder = {
  async build(): Promise<Buffer> {
    return Buffer.from('bellhop demo placeholder binary\n');
  },
};

export async function startDemoServer({ port, serveClient = true }: StartDemoServerOptions): Promise<DemoServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-demo-'));
  const inventoryPath = path.join(dir, 'bellhop.db');
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  isolateEnvironment(inventoryPath, dataDir);

  let jobStore: JobStore | undefined;
  const removeDir = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  try {
    saveInventory(inventoryPath, buildDemoInventory());
    const inventory = loadInventory(inventoryPath);

    const ssh = new DemoSSHClient(inventory);
    const jobsDbPath = path.join(dataDir, 'jobs.sqlite3');
    jobStore = new JobStore(jobsDbPath);
    const jobLog = createJobLog(path.join(dataDir, 'job-logs'));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    seedDemoJobs(jobStore, jobLog, jobsDbPath, jobRunner.owner);

    const impersonationStore: ImpersonationStore = new Map();
    const app = buildApp({
      inventory,
      baseSsh: ssh,
      jobStore,
      jobLog,
      jobRunner,
      inventoryPath,
      authentik: new UnconfiguredAuthentikClient(),
      cloudflare: new UnconfiguredCloudflareClient(),
      impersonationStore,
      goBuilder: demoGoBuilder,
      fetchImpl: demoFetch,
    });

    const outer = express();
    outer.use((req, _res, next) => {
      setDemoIdentity(req.headers);
      next();
    });
    outer.use(app);
    if (serveClient) {
      const clientDist = path.join(REPO_ROOT, 'web-client', 'dist');
      outer.use(express.static(clientDist));
      outer.get(/^(?!\/api|\/ws).*/, (_req, res) => {
        res.sendFile(path.join(clientDist, 'index.html'));
      });
    }

    const server = http.createServer(outer);
    // /ws/jobs/:id is handled on the raw server, outside Express -- prepended
    // so the headers are in place before attachJobsWebSocket's own listener
    // resolves the user.
    server.prependListener('upgrade', (req) => setDemoIdentity(req.headers));
    const wss = attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, impersonationStore);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });

    const actualPort = (server.address() as AddressInfo).port;
    const store = jobStore;
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        removeDir();
      })();
      return closing;
    };

    return { url: `http://localhost:${actualPort}`, port: actualPort, dir, inventoryPath, close };
  } catch (err) {
    jobStore?.close();
    removeDir();
    throw err;
  }
}
