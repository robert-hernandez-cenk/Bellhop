import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { McpHttpHost, type McpPrincipal } from '../../../src/web/mcp/http-host.ts';
import { mcpHttpDeps, listen, connectHttpClient, rawPost, INITIALIZE } from '../../support/mcp-http-harness.ts';
import { parse, until, waitForFinished } from '../../support/mcp-harness.ts';
import { HangingSSHClient } from '../../support/hanging-ssh-client.ts';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';

// The host alone (#65/#66, FR-003/FR-006): authentication is mcpRoutes'
// job, so these tests hand it a principal from a test header.
async function setup(opts: { now?: () => number } = {}) {
  const { deps, jobStore } = mcpHttpDeps();
  const host = new McpHttpHost({ deps, now: opts.now });
  const app = express();
  app.use(express.json());
  app.all('/mcp', (req, res) => {
    const id = String(req.headers['x-test-principal'] ?? 'grant:1');
    const username = String(req.headers['x-test-username'] ?? (id === 'api-key' ? 'api-key' : 'admin'));
    const principal: McpPrincipal = { id, username };
    void host.handle(req, res, principal);
  });
  const server = await listen(app);
  const url = `${server.base}/mcp`;
  return {
    host,
    url,
    jobStore,
    close: async () => {
      await host.close();
      await server.close();
    },
  };
}

test('an MCP client initializes a session over HTTP and calls a tool', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { client, call } = await connectHttpClient(s.url);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'get_inventory'));
  const inventory = parse(await call('get_inventory'));
  assert.equal(inventory.domain, 'example.com');
  assert.equal(s.host.size, 1);
});

test('a request naming an unknown session id is answered 404', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, { 'mcp-session-id': 'no-such-session' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.status, 404);
});

test('a request without a session id that is not initialize is answered 400', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, {}, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.status, 400);
});

// 404, not 403 (review finding): after a re-authorization the same person
// holds a new grant, and 404 is what makes a client open a new session.
test("a session answers another principal's request with 404", async (t) => {
  const s = await setup();
  t.after(s.close);
  const { transport } = await connectHttpClient(s.url, { headers: { 'x-test-principal': 'grant:1' } });
  const sessionId = transport.sessionId!;
  const other = await rawPost(
    s.url,
    { 'mcp-session-id': sessionId, 'x-test-principal': 'api-key', 'mcp-protocol-version': '2025-06-18' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  );
  assert.equal(other.status, 404);
});

test('a raw initialize creates a session and returns its id', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, {}, INITIALIZE);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('mcp-session-id'));
});

test('the idle sweep closes a session unused for 30 minutes, after which its id is unknown', async (t) => {
  let now = 1_000_000;
  const s = await setup({ now: () => now });
  t.after(s.close);
  const { transport } = await connectHttpClient(s.url);
  const sessionId = transport.sessionId!;
  now += 29 * 60 * 1000;
  s.host.sweep();
  assert.equal(s.host.size, 1, 'not idle long enough yet');
  now += 60 * 1000;
  s.host.sweep();
  assert.equal(s.host.size, 0);
  const res = await rawPost(
    s.url,
    { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' }
  );
  assert.equal(res.status, 404);
});

// --- US5: jobs and prompts across HTTP sessions (FR-004, FR-005) -----------

const DONE = { stdout: 'done', stderr: '', code: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An install-app-shaped job on the web runner that prints a prompt and
// blocks on stdin; firePrompt() pauses it (the detector's timer is captured).
async function promptingHost(opts: { now?: () => number } = {}) {
  const hanging = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const { deps, jobStore, jobRunner } = mcpHttpDeps({
    jobSsh: hanging,
    runnerOptions: {
      promptScheduleCheck: (fn) => {
        fireCheck = fn;
        return { cancel: () => { if (fireCheck === fn) fireCheck = undefined; } };
      },
    },
  });
  const host = new McpHttpHost({ deps, now: opts.now });
  const app = express();
  app.use(express.json());
  app.all('/mcp', (req, res) =>
    void host.handle(req, res, { id: 'grant:1', username: String(req.headers['x-test-username'] ?? 'admin') })
  );
  const server = await listen(app);
  const id = jobRunner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    target: 'app-lxc',
    argsJson: '{}',
    watchForPrompts: true,
    expectedPrompts: ['Add Adminer?'],
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });
  await until(() => jobStore.get(id)?.status === 'running' && fireCheck !== undefined, 'job running');
  return {
    url: `${server.base}/mcp`,
    host,
    hanging,
    jobStore,
    jobRunner,
    id,
    firePrompt: () => fireCheck!(),
    close: async () => {
      if (!['success', 'failed', 'cancelled', 'interrupted'].includes(jobStore.get(id)?.status ?? '')) {
        jobRunner.cancel(id);
        await waitForFinished(jobStore, id);
      }
      await host.close();
      await server.close();
    },
  };
}

test('two HTTP sessions waiting on one paused job produce one dialog, and the answer resumes it', async (t) => {
  const p = await promptingHost();
  t.after(p.close);
  let asked = 0;
  let release: (() => void) | undefined;
  const elicit = async (): Promise<ElicitResult> => {
    asked++;
    await new Promise<void>((r) => (release = r));
    return { action: 'accept', content: { action: 'answer', answer: 'y' } };
  };
  const a = await connectHttpClient(p.url, { elicit });
  const b = await connectHttpClient(p.url, { elicit });
  p.firePrompt();
  const waitA = a.call('wait_for_job', { id: p.id });
  const waitB = b.call('wait_for_job', { id: p.id });
  await until(() => release !== undefined, 'dialog open');
  await sleep(50);
  assert.equal(asked, 1, 'one dialog across both sessions');
  release!();
  await until(() => p.hanging.writes.length === 1, 'answer written');
  p.hanging.finish(DONE);
  const [ra, rb] = await Promise.all([waitA, waitB]);
  assert.equal(parse(ra).outcome, 'finished');
  assert.equal(parse(rb).outcome, 'finished');
  assert.equal(asked, 1);
});

test('a job keeps running, owned by the web runner, after its MCP client disconnects', async (t) => {
  const p = await promptingHost();
  t.after(p.close);
  const client = await connectHttpClient(p.url);
  assert.equal(parse(await client.call('get_job', { id: p.id })).job.status, 'running');
  await client.transport.terminateSession();
  await client.client.close();
  await sleep(20);
  assert.equal(p.host.size, 0, 'the session is gone');
  assert.equal(p.jobStore.get(p.id)?.status, 'running');
  assert.equal(p.jobStore.get(p.id)?.owner, 'web');
  p.hanging.finish(DONE);
  await waitForFinished(p.jobStore, p.id);
  assert.equal(p.jobStore.get(p.id)?.status, 'success');
});

// Review finding: the idle sweep must not close a session while one of its
// requests is still running (a long wait_for_job), and idleness counts from
// when that request ended.
test('the idle sweep spares a session with a request in flight, and counts from its end', async (t) => {
  let now = 1_000_000;
  const p = await promptingHost({ now: () => now });
  t.after(p.close);
  const client = await connectHttpClient(p.url);
  const waiting = client.call('wait_for_job', { id: p.id, maxWaitSeconds: 3600 });
  await sleep(100);
  now += 45 * 60 * 1000;
  p.host.sweep();
  assert.equal(p.host.size, 1, 'kept while wait_for_job runs');
  p.hanging.finish(DONE);
  assert.equal(parse(await waiting).outcome, 'finished');
  now += 29 * 60 * 1000;
  p.host.sweep();
  assert.equal(p.host.size, 1, 'idle only since the request ended');
  now += 2 * 60 * 1000;
  p.host.sweep();
  assert.equal(p.host.size, 0);
});

// Review finding: a client that vanishes mid-dialog (killed, no DELETE) must
// not keep the shared prompt claim -- its abandoned request is cancelled, so
// the next session asks again at once.
test('a client that drops its connection mid-dialog frees the prompt for the next session', async (t) => {
  const p = await promptingHost();
  t.after(p.close);
  let firstAsked = false;
  const gone = await connectHttpClient(p.url, {
    elicit: async (_req, signal) => {
      firstAsked = true;
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      throw new Error('unreachable');
    },
  });
  p.firePrompt();
  void gone.call('wait_for_job', { id: p.id }).catch(() => {});
  await until(() => firstAsked, 'first dialog open');
  await gone.transport.close(); // drops the connection without DELETE

  let secondAsked = false;
  const next = await connectHttpClient(p.url, {
    elicit: async () => {
      secondAsked = true;
      return { action: 'accept', content: { action: 'answer', answer: 'y' } };
    },
  });
  const waiting = next.call('wait_for_job', { id: p.id, maxWaitSeconds: 5 });
  await until(() => secondAsked, 'second session asked');
  await until(() => p.hanging.writes.length === 1, 'answer written');
  p.hanging.finish(DONE);
  assert.equal(parse(await waiting).outcome, 'finished');
});

// Review finding: jobs record the identity's current username (a rename in
// Authentik lands on the next request), not the one seen at initialize.
test('a session records the username each request carries', async (t) => {
  const p = await setup();
  t.after(p.close);
  const client = await connectHttpClient(p.url, { headers: { 'x-test-username': 'old-name' } });
  // Same session, renamed caller: rebuild the client's headers by sending raw.
  const sessionId = client.transport.sessionId!;
  const res = await rawPost(
    p.url,
    { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18', 'x-test-username': 'new-name' },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_lxc', arguments: { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12', apply: true } } }
  );
  const text = await res.text();
  const jobId = Number(/\\"jobId\\": (\d+)/.exec(text)?.[1]);
  assert.ok(jobId, text);
  await waitForFinished(p.jobStore, jobId);
  assert.equal(p.jobStore.get(jobId)?.triggeredByUsername, 'new-name');
});

// Review finding: over HTTP, jobs belong to the web service and outlive the
// client, so the tool descriptions must not say they are interrupted.
test('tool descriptions over HTTP say jobs keep running, not that they are interrupted', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { client } = await connectHttpClient(s.url);
  const { tools } = await client.listTools();
  const createLxc = tools.find((tool) => tool.name === 'create_lxc')!;
  const wait = tools.find((tool) => tool.name === 'wait_for_job')!;
  assert.doesNotMatch(createLxc.description!, /interrupted/);
  assert.match(createLxc.description!, /keep running/);
  assert.doesNotMatch(wait.description!, /this server started/);
});
