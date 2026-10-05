import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/web/app.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { SetupService } from '../../src/web/setup/service.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { FakeSSHClient, type FakeSSHResponder } from './fake-ssh-client.ts';
import { FakeAuthentikClient } from './fake-authentik-client.ts';
import { newTestSessions } from './web-session.ts';

export interface SetupTestApp {
  app: ReturnType<typeof buildApp>;
  setup: SetupService;
  inventoryPath: string;
  dataDir: string;
  inventory: Inventory;
  ssh: FakeSSHClient;
  token: string | undefined;
  // The Cookie header a browser holds after the token exchange.
  cookie: string;
}

// A web app over a fresh temp inventory with the setup service started the
// way server.ts starts it (issue #86). Pass an inventory with hosts to get an
// existing deployment (setup not applicable).
export function setupTestApp(
  opts: { inventory?: Inventory; responder?: FakeSSHResponder; inventoryPath?: string; dataDir?: string } = {}
): SetupTestApp {
  const inventoryPath =
    opts.inventoryPath ?? path.join(mkdtempSync(path.join(tmpdir(), 'setup-app-')), 'bellhop.db');
  if (!opts.inventoryPath) saveInventory(inventoryPath, opts.inventory ?? { hosts: [], guests: [] });
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(tmpdir(), 'setup-data-'));
  const inventory = loadInventory(inventoryPath);
  const ssh = new FakeSSHClient(opts.responder ?? (() => ({ stdout: '', stderr: '', code: 0 })));
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'setup-joblog-')));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const setup = new SetupService({ inventoryPath, inventory, dataDir });
  const token = setup.start();
  const app = buildApp({
    sessions: newTestSessions(),
    inventory,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    setup,
  });
  return { app, setup, inventoryPath, dataDir, inventory, ssh, token, cookie: `bellhop_setup=${token ?? ''}` };
}
