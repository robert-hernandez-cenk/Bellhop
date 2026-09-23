import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { HangingSSHClient } from '../support/hanging-ssh-client.ts';
import { parse, setupMcp, until, waitForFinished, type McpHarnessOptions, type TextResult } from '../support/mcp-harness.ts';

const DONE = { stdout: 'done', stderr: '', code: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An install-app-shaped job that prints a prompt and blocks on stdin. The
// prompt detector's timer is captured instead of real, so firePrompt() pauses
// the job synchronously.
async function promptJob(opts: Pick<McpHarnessOptions, 'elicit' | 'serverOptions'> = {}) {
  const hanging = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const h = await setupMcp({
    ...opts,
    jobSsh: hanging,
    runnerOptions: {
      promptScheduleCheck: (fn) => {
        fireCheck = fn;
        return { cancel: () => { if (fireCheck === fn) fireCheck = undefined; } };
      },
    },
  });
  const id = h.jobRunner.enqueue({
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
  await until(() => h.jobStore.get(id)?.status === 'running' && fireCheck !== undefined, 'job running');
  return {
    ...h,
    hanging,
    id,
    firePrompt: () => {
      assert.ok(fireCheck, 'prompt check not armed');
      fireCheck();
      assert.equal(h.jobStore.get(id)?.status, 'awaiting_input');
    },
    // Every prompt test ends here: an unanswered job holds a 15-minute
    // abandon timer that would keep the test process alive.
    stop: async () => {
      h.jobRunner.cancel(id);
      await waitForFinished(h.jobStore, id);
    },
  };
}

test('returns finished at once for a job that already ended, with the log tail', async () => {
  const h = await setupMcp();
  const id = h.jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'mcp:test' });
  h.jobLog.append(h.jobStore.get(id)!.logFile, 'x'.repeat(25_000) + 'END');
  h.jobStore.markFinished(id, { status: 'success', exitCode: 0 });

  const body = parse(await h.call('wait_for_job', { id }));
  assert.equal(body.outcome, 'finished');
  assert.equal(body.job.status, 'success');
  assert.equal(body.prompt, null);
  assert.equal(body.log.length, 20_000);
  assert.ok(body.log.endsWith('END'));
  assert.equal(body.nextOffset, 25_003);
  assert.equal(body.hasMore, false);
});

test('returns still_running once maxWaitSeconds passes', async () => {
  const h = await setupMcp();
  const id = h.jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'mcp:test' });
  h.jobStore.markRunning(id);
  const started = Date.now();
  const body = parse(await h.call('wait_for_job', { id, maxWaitSeconds: 1 }));
  assert.equal(body.outcome, 'still_running');
  assert.ok(Date.now() - started >= 900);
});

test("refuses another process's job with the owner named", async () => {
  const h = await setupMcp();
  const id = h.jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'web' });
  h.jobStore.markRunning(id);
  const result = await h.call('wait_for_job', { id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /owned by web/);
});

test('a client without elicitation gets prompt_pending immediately', async () => {
  const p = await promptJob();
  p.firePrompt();
  const body = parse(await p.call('wait_for_job', { id: p.id }));
  assert.equal(body.outcome, 'prompt_pending');
  assert.deepEqual(body.prompt, { text: 'Add Adminer? (y/N) ', origin: 'expected' });
  assert.equal(p.jobStore.get(p.id)?.status, 'awaiting_input');
  await p.stop();
});

test('an accepted answer is written to the job and the wait continues to the end', async () => {
  const requests: ElicitRequest[] = [];
  const p = await promptJob({
    elicit: async (request) => {
      requests.push(request);
      return { action: 'accept', content: { action: 'answer', answer: 'y' } };
    },
  });
  const pending = p.call('wait_for_job', { id: p.id });
  p.firePrompt();
  await until(() => p.hanging.writes.length === 1, 'answer written');
  assert.deepEqual(p.hanging.writes, ['y\n']);
  p.hanging.finish(DONE);

  const body = parse(await pending);
  assert.equal(body.outcome, 'finished');
  assert.equal(body.job.status, 'success');
  assert.equal(requests.length, 1);
  assert.match(requests[0].params.message, /Job \d+ \(install-app on app-lxc\)/);
  assert.match(requests[0].params.message, /^Add Adminer\?/);
  const params = requests[0].params as unknown as { requestedSchema: { properties: { answer: { title: string } } } };
  assert.match(params.requestedSchema.properties.answer.title, /Add Adminer\?/);
});

test('an accepted empty answer sends a bare newline', async () => {
  const p = await promptJob({ elicit: async () => ({ action: 'accept', content: { action: 'answer' } }) });
  const pending = p.call('wait_for_job', { id: p.id });
  p.firePrompt();
  await until(() => p.hanging.writes.length === 1, 'newline written');
  assert.deepEqual(p.hanging.writes, ['\n']);
  p.hanging.finish(DONE);
  assert.equal(parse(await pending).outcome, 'finished');
});

test('resume dismisses the prompt without writing anything', async () => {
  let asked = 0;
  const p = await promptJob({
    elicit: async () => {
      asked++;
      return { action: 'accept', content: { action: 'resume' } };
    },
  });
  const pending = p.call('wait_for_job', { id: p.id });
  p.firePrompt();
  await until(() => asked === 1 && p.jobStore.get(p.id)?.status === 'running', 'resumed');
  assert.deepEqual(p.hanging.writes, []);
  p.hanging.finish(DONE);
  assert.equal(parse(await pending).job.status, 'success');
});

test('the cancel choice cancels the job and does not re-ask', async () => {
  let asked = 0;
  const p = await promptJob({
    elicit: async () => {
      asked++;
      return { action: 'accept', content: { action: 'cancel' } };
    },
  });
  const pending = p.call('wait_for_job', { id: p.id });
  p.firePrompt();
  const body = parse(await pending);
  assert.equal(body.outcome, 'finished');
  assert.equal(body.job.status, 'cancelled');
  assert.equal(asked, 1);
});

test('a decline returns prompt_pending and leaves the job paused', async () => {
  const p = await promptJob({ elicit: async () => ({ action: 'decline' }) });
  p.firePrompt();
  const body = parse(await p.call('wait_for_job', { id: p.id }));
  assert.equal(body.outcome, 'prompt_pending');
  assert.equal(body.elicitationError, undefined);
  assert.equal(p.jobStore.get(p.id)?.status, 'awaiting_input');
  await p.stop();
});

test('an elicitation error is handed back as prompt_pending with the message', async () => {
  const p = await promptJob({
    elicit: async () => {
      throw new Error('dialog broke');
    },
  });
  p.firePrompt();
  const body = parse(await p.call('wait_for_job', { id: p.id }));
  assert.equal(body.outcome, 'prompt_pending');
  assert.match(body.elicitationError, /dialog broke/);
  await p.stop();
});

// #174: a client that never shows the dialog (a remote session) must not
// hold the wait until the job's 15-minute abandon timer cancels it.
test('an unanswered dialog is withdrawn after the timeout and handed back as prompt_pending', async () => {
  let asked = 0;
  let dialogSignal: AbortSignal | undefined;
  const p = await promptJob({
    elicit: (_request, signal) => {
      asked++;
      dialogSignal = signal;
      return new Promise<ElicitResult>((resolve) => signal.addEventListener('abort', () => resolve({ action: 'cancel' })));
    },
    serverOptions: { elicitationTimeoutMs: 100 },
  });
  p.firePrompt();
  const body = parse(await p.call('wait_for_job', { id: p.id, maxWaitSeconds: 60 }));
  assert.equal(body.outcome, 'prompt_pending');
  assert.match(body.elicitationError, /No answer in the prompt dialog within 0\.1 seconds/);
  assert.match(body.elicitationError, /answer_job_prompt/);
  await until(() => dialogSignal!.aborted, 'dialog withdrawn');
  assert.equal(p.jobStore.get(p.id)?.status, 'awaiting_input');

  // Handed off like a decline: a later call does not reopen the dialog.
  assert.equal(parse(await p.call('wait_for_job', { id: p.id })).outcome, 'prompt_pending');
  assert.equal(asked, 1);
  await p.stop();
});

test('a prompt answered elsewhere withdraws the open dialog and the wait carries on', async () => {
  let dialogSignal: AbortSignal | undefined;
  const p = await promptJob({
    elicit: (_request, signal) => {
      dialogSignal = signal;
      return new Promise<ElicitResult>((resolve) => signal.addEventListener('abort', () => resolve({ action: 'cancel' })));
    },
  });
  p.firePrompt();
  const pending = p.call('wait_for_job', { id: p.id });
  await until(() => dialogSignal !== undefined, 'dialog open');
  assert.ok(p.jobRunner.answerPrompt(p.id, 'n'));
  await until(() => dialogSignal!.aborted, 'dialog withdrawn');
  p.hanging.finish(DONE);

  const body = parse(await pending);
  assert.equal(body.outcome, 'finished');
  assert.deepEqual(p.hanging.writes, ['n\n']);
});

test('two concurrent waiters produce one dialog', async () => {
  let asked = 0;
  let release: (() => void) | undefined;
  const p = await promptJob({
    elicit: async () => {
      asked++;
      await new Promise<void>((r) => (release = r));
      return { action: 'accept', content: { action: 'answer', answer: 'y' } };
    },
  });
  p.firePrompt();
  const a = p.call('wait_for_job', { id: p.id });
  const b = p.call('wait_for_job', { id: p.id });
  await until(() => release !== undefined, 'dialog open');
  await sleep(50);
  assert.equal(asked, 1);
  release!();
  await until(() => p.hanging.writes.length === 1, 'answer written');
  p.hanging.finish(DONE);

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(parse(ra).outcome, 'finished');
  assert.equal(parse(rb).outcome, 'finished');
  assert.equal(asked, 1);
});

test('a decline hands the prompt to the concurrent waiter and to later calls', async () => {
  let asked = 0;
  let release: (() => void) | undefined;
  const p = await promptJob({
    elicit: async () => {
      asked++;
      await new Promise<void>((r) => (release = r));
      return { action: 'decline' };
    },
  });
  p.firePrompt();
  const a = p.call('wait_for_job', { id: p.id });
  const b = p.call('wait_for_job', { id: p.id, maxWaitSeconds: 60 });
  await until(() => release !== undefined, 'dialog open');
  await sleep(50);
  release!();

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(parse(ra).outcome, 'prompt_pending');
  assert.equal(parse(rb).outcome, 'prompt_pending');
  assert.equal(parse(await p.call('wait_for_job', { id: p.id })).outcome, 'prompt_pending');
  assert.equal(asked, 1);
  await p.stop();
});

test('cancelling the tool call withdraws the dialog but leaves the job paused', async () => {
  let dialogSignal: AbortSignal | undefined;
  const p = await promptJob({
    elicit: (_request, signal) => {
      dialogSignal = signal;
      return new Promise<ElicitResult>((resolve) => signal.addEventListener('abort', () => resolve({ action: 'cancel' })));
    },
  });
  const baseline = p.jobRunner.events.listenerCount('status');
  p.firePrompt();
  const controller = new AbortController();
  const pending = p.client.callTool({ name: 'wait_for_job', arguments: { id: p.id } }, undefined, { signal: controller.signal });
  await until(() => dialogSignal !== undefined, 'dialog open');
  controller.abort();
  await assert.rejects(pending);
  await until(() => dialogSignal!.aborted, 'dialog withdrawn');
  await until(() => p.jobRunner.events.listenerCount('status') === baseline, 'listeners removed');
  assert.equal(p.jobStore.get(p.id)?.status, 'awaiting_input');
  await p.stop();
});

test('an unexpected error after the human responds still releases the generation', async () => {
  const p = await promptJob({ elicit: async () => ({ action: 'accept', content: { action: 'cancel' } }) });
  const realCancel = p.jobRunner.cancel.bind(p.jobRunner);
  p.jobRunner.cancel = () => {
    throw new Error('boom');
  };
  p.firePrompt();
  const result = await p.call('wait_for_job', { id: p.id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
  // Job never actually got cancelled (the stub threw instead), and the
  // generation must have been released despite the throw, or this would
  // see 'busy' forever instead of being askable again.
  assert.equal(p.jobStore.get(p.id)?.status, 'awaiting_input');

  p.jobRunner.cancel = realCancel;
  await p.stop();
});

test('sends progress notifications while waiting', async () => {
  const h = await setupMcp({ serverOptions: { progressIntervalMs: 20 } });
  const id = h.jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'mcp:test' });
  h.jobStore.markRunning(id);
  const messages: string[] = [];
  const result = await h.client.callTool({ name: 'wait_for_job', arguments: { id, maxWaitSeconds: 1 } }, undefined, {
    onprogress: (progress) => messages.push(progress.message ?? ''),
  });
  assert.equal(parse(result as TextResult).outcome, 'still_running');
  assert.ok(messages.length >= 3, `only ${messages.length} progress notifications`);
  assert.ok(messages.every((m) => m === 'running'));
});

test('sends an "awaiting answer" progress message while a prompt dialog is open', async () => {
  let release: (() => void) | undefined;
  const p = await promptJob({
    elicit: async () => {
      await new Promise<void>((r) => (release = r));
      return { action: 'accept', content: { action: 'cancel' } };
    },
    serverOptions: { progressIntervalMs: 20 },
  });
  p.firePrompt();
  const messages: string[] = [];
  const pending = p.client.callTool({ name: 'wait_for_job', arguments: { id: p.id, maxWaitSeconds: 60 } }, undefined, {
    onprogress: (progress) => messages.push(progress.message ?? ''),
  });
  await until(() => release !== undefined, 'dialog open');
  await until(() => messages.includes('awaiting answer'), 'awaiting answer progress');
  release!();

  // Ends with the job cancelled (via the dialog's own cancel choice), so no
  // 15-minute abandon timer is left running.
  const body = parse((await pending) as TextResult);
  assert.equal(body.outcome, 'finished');
  assert.equal(body.job.status, 'cancelled');
});
