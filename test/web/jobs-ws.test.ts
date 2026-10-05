import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { attachJobsWebSocket } from '../../src/web/routes/jobs.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { newTestSessions, sessionCookie } from '../support/web-session.ts';
import { resetConfigStore, tempConfigStore } from '../support/config-store.ts';
import { savePermissionGroup } from '../../src/lib/permissions.ts';
import { saveInventory } from '../../src/lib/inventory.ts';
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
  const sessions = newTestSessions();
  const wss = attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, { domain: 'example.com', hosts: [], guests: [] }, new Map(), sessions);
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
  // allows an admin caller through -- the session's groups here match the
  // admin bypass, keeping this test's original purpose (streamed status +
  // chunk events for the connected job) intact under the newer per-job
  // visibility check added for issue #13.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/jobs/${id}`, {
    headers: { Cookie: sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] }) },
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

// --- #69 US1: the upgrade authenticates from the bellhop_session cookie -------

// A server whose only job id (1) does not exist, so its target resolves to
// fleet-wide and only an admin caller may watch it (isJobVisible).
async function startServer(sessions = newTestSessions(), impersonation = new Map<string, string>()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const jobRunner = new JobRunner(jobStore, jobLog, new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })));
  const inventory = { domain: 'example.com', hosts: [], guests: [] };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  savePermissionGroup(inventoryPath, 'family', { mode: 'block-list', resources: [] });
  const server = http.createServer();
  const wss = attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, inventory, impersonation, sessions);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, sessions, close };
}

function connect(port: number, headers: Record<string, string> = {}): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/jobs/1`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => resolve('refused'));
  });
}

// oidc mode with the suite-wide WEB_UI_DEV_USER removed, so a request with no
// session really is unauthenticated.
async function inOidcMode(fn: () => Promise<void>): Promise<void> {
  tempConfigStore({ webUiAuthMode: 'oidc' });
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    await fn();
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
    resetConfigStore();
  }
}

test('WS upgrade with a valid bellhop_session cookie is accepted', async () => {
  await inOidcMode(async () => {
    const { port, sessions, close } = await startServer();
    try {
      const cookie = sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] });
      assert.equal(await connect(port, { Cookie: cookie }), 'open');
    } finally {
      await close();
    }
  });
});

test('WS upgrade without a session cookie is destroyed in oidc mode', async () => {
  await inOidcMode(async () => {
    const { port, close } = await startServer();
    try {
      assert.equal(await connect(port), 'refused');
      assert.equal(await connect(port, { Cookie: 'bellhop_session=not-a-real-session' }), 'refused');
    } finally {
      await close();
    }
  });
});

test('WS upgrade with only x-authentik-* headers is destroyed', async () => {
  await inOidcMode(async () => {
    const { port, close } = await startServer();
    try {
      const outcome = await connect(port, {
        'x-authentik-username': 'admin',
        'x-authentik-groups': 'bellhop-admins',
        'x-authentik-uid': 'uid-admin',
      });
      assert.equal(outcome, 'refused');
    } finally {
      await close();
    }
  });
});

test('WS upgrade re-checks a due session like requireAuth, and a refusal destroys the socket', async () => {
  await inOidcMode(async () => {
    let clock = 1_000_000;
    const sessions = newTestSessions({ now: () => clock });
    const { port, close } = await startServer(sessions);
    try {
      const cookie = sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] });
      clock += 6 * 60 * 1000;
      sessions.client.recheckResults.push({ kind: 'refused', reason: 'Re-check with the example issuer was refused: HTTP 400 invalid_grant' });
      assert.equal(await connect(port, { Cookie: cookie }), 'refused');
      assert.equal(sessions.client.callsTo('recheck').length, 1);
    } finally {
      await close();
    }
  });
});

test('WS upgrade still applies the impersonation overlay, keyed by the session username', async () => {
  await inOidcMode(async () => {
    const { port, sessions, close } = await startServer(newTestSessions(), new Map([['admin', 'family']]));
    try {
      // The admin is impersonating a non-admin group, which cannot see a
      // fleet-wide job; a different admin with no overlay still can.
      const impersonating = sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] });
      assert.equal(await connect(port, { Cookie: impersonating }), 'refused');
      const other = sessionCookie(sessions, { username: 'other-admin', groups: ['bellhop-admins'] });
      assert.equal(await connect(port, { Cookie: other }), 'open');
    } finally {
      await close();
    }
  });
});
