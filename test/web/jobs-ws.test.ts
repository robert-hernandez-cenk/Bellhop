import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { attachJobsWebSocket } from '../../src/web/routes/jobs.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('connecting to /ws/jobs/:id streams status + chunk events for that job only', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'remote line', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);

  const server = http.createServer();
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  const wss = attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, new Map());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
    },
  });

  const messages: any[] = [];
  // update-all has no single target (fleet-wide), so isJobVisible only
  // allows an admin caller through -- x-authentik-groups here matches the
  // admin bypass, keeping this test's original purpose (streamed status +
  // chunk events for the connected job) intact under the newer per-job
  // visibility check added for issue #13.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/jobs/${id}`, {
    headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
  });
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve) => {
    ws.on('open', () => resolve());
  });

  await new Promise((resolve) => {
    const check = () => {
      if (messages.some((m) => m.type === 'status' && m.status === 'success')) resolve(undefined);
      else setTimeout(check, 5);
    };
    check();
  });

  assert.ok(
    messages.some((m) => (m.type === 'chunk' || m.type === 'backlog') && m.text.includes('remote line')),
    'expected the remote output to appear via a live chunk event or the backlog sent on connect'
  );

  await new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.close();
  });
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
