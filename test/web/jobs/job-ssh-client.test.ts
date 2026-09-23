import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobSSHClient } from '../../../src/web/jobs/job-ssh-client.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import type { ExecResult, SSHClient, SshTarget } from '../../../src/lib/ssh-client.ts';

test('JobSSHClient forwards exec to the inner client and threads onChunk through', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'out', stderr: '', code: 0 }));
  const seen: Array<{ text: string; stream: string }> = [];
  const client = new JobSSHClient(inner, (chunk, stream) => seen.push({ text: chunk, stream }));
  const result = await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
  assert.equal(result.stdout, 'out');
  assert.deepEqual(seen, [{ text: 'out', stream: 'stdout' }]);
  assert.equal(inner.history.length, 1);
});

test('JobSSHClient threads its constructor signal through to the inner client', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'out', stderr: '', code: 0 }));
  const controller = new AbortController();
  controller.abort();
  const client = new JobSSHClient(inner, () => {}, controller.signal);
  await assert.rejects(() => client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi'), /Job cancelled/);
});

test('JobSSHClient.execInteractive rejects -- interactive mode is CLI-only, there is no terminal in a web job context', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'out', stderr: '', code: 0 }));
  const client = new JobSSHClient(inner, () => {});
  await assert.rejects(() => client.execInteractive({ host: 'pve1.local', user: 'root' }, 'echo hi'), /not available/);
});

function fakeScheduler() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    scheduleCheck: (fn: () => void, _ms: number) => {
      const entry = { fn, cancelled: false };
      pending.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    fireLatest: () => {
      const entry = pending[pending.length - 1];
      if (entry && !entry.cancelled) entry.fn();
    },
  };
}

test('JobSSHClient detects a silent, question-shaped trailing chunk and fires onPromptDetected', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Add Adminer? (y/N) ', stderr: '', code: 0 }));
  const detected: Array<{ text: string; expectedPrompts: string[] }> = [];
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    expectedPrompts: ['Add Adminer?'],
    onPromptDetected: (text, expectedPrompts) => detected.push({ text, expectedPrompts }),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  await promise;

  assert.equal(detected.length, 1);
  assert.equal(detected[0].text, 'Add Adminer? (y/N) ');
  assert.deepEqual(detected[0].expectedPrompts, ['Add Adminer?']);
});

test('JobSSHClient does not fire onPromptDetected when the trailing text is not question-shaped', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Downloading dependencies...', stderr: '', code: 0 }));
  const detected: string[] = [];
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text) => detected.push(text),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  await promise;

  assert.equal(detected.length, 0);
});

test('resume() clears paused state so a later prompt in the same job can still be detected', async () => {
  const responses = ['Add Adminer? (y/N) ', 'Continue? (y/n) '];
  let call = 0;
  const inner = new FakeSSHClient(() => ({ stdout: responses[call++], stderr: '', code: 0 }));
  const detected: string[] = [];
  let resumeFn: (() => void) | undefined;
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, resume) => {
      detected.push(text);
      resumeFn = resume;
    },
    scheduleCheck,
  });

  const promise1 = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Two fires: tier 0 (expected hints only) finds nothing and arms tier 1,
  // which is where the (y/N) heuristic lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireLatest();
  fireLatest();
  await promise1;
  assert.equal(detected.length, 1);

  resumeFn?.();

  const promise2 = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Two fires: tier 0 (expected hints only) finds nothing and arms tier 1,
  // which is where the (y/N) heuristic lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireLatest();
  fireLatest();
  await promise2;

  assert.deepEqual(detected, ['Add Adminer? (y/N) ', 'Continue? (y/n) ']);
});

test('JobSSHClient detects an angle-bracket y/N prompt like paperless-ngx actually emits', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Would you like to add Adminer? <y/N> ', stderr: '', code: 0 }));
  const detected: string[] = [];
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text) => detected.push(text),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Two fires: tier 0 (expected hints only) finds nothing and arms tier 1,
  // which is where the (y/N) heuristic lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireLatest();
  fireLatest();
  await promise;

  assert.equal(detected.length, 1);
  assert.equal(detected[0], 'Would you like to add Adminer? <y/N> ');
});

test('JobSSHClient strips ANSI escape codes both from what it matches and from the detected promptText', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: '\x1b[32mAdd Adminer?\x1b[0m (y/N) ', stderr: '', code: 0 }));
  const detected: string[] = [];
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text) => detected.push(text),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Two fires: tier 0 (expected hints only) finds nothing and arms tier 1,
  // which is where the (y/N) heuristic lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireLatest();
  fireLatest();
  await promise;

  assert.equal(detected.length, 1);
  assert.ok(!detected[0].includes('\x1b'));
  assert.equal(detected[0], 'Add Adminer? (y/N) ');
});

test('the write function passed to onPromptDetected writes into the captured stdin of the inner exec call', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Add Adminer? (y/N) ', stderr: '', code: 0 }));
  let writeFn: ((text: string) => void) | undefined;
  const { scheduleCheck, fireLatest } = fakeScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (_text, _expected, write) => {
      writeFn = write;
    },
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Two fires: tier 0 (expected hints only) finds nothing and arms tier 1,
  // which is where the (y/N) heuristic lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireLatest();
  fireLatest();
  writeFn?.('y\n');
  await promise;

  assert.deepEqual(inner.stdinWriteHistory.map((w) => w.text), ['y\n']);
});

// The default fakeScheduler above ignores the delay. These tests need to see
// which tier armed, so they record it.
function tieredScheduler() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    scheduleCheck: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      delays.push(ms);
      return { cancel: () => { entry.cancelled = true; } };
    },
    delays,
    // Exposed (read-only in spirit) for tests that need to grab a specific
    // armed handle -- e.g. to check whether it was cancelled by a later
    // rearm -- rather than only ever firing the most recent one.
    pending,
    fireLatest: () => {
      const entry = pending[pending.length - 1];
      if (entry && !entry.cancelled) entry.fn();
    },
  };
}

test('a pre-scanned prompt the heuristics would miss is detected at the first tier, tagged expected', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: '   Enter the Cloudflare API token: ', stderr: '', code: 0 }));
  const detected: Array<{ text: string; origin: string; matchedIndex: number | null }> = [];
  const { scheduleCheck, delays, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    expectedPrompts: ['${TAB3}Enter the Cloudflare API token: ', '${TAB3}Proxied? (y/n): '],
    onPromptDetected: (text, _expected, _write, _resume, origin, matchedIndex) =>
      detected.push({ text, origin, matchedIndex }),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  await promise;

  assert.equal(delays[0], 2000);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].text, '   Enter the Cloudflare API token: ');
  assert.equal(detected[0].origin, 'expected');
  assert.equal(detected[0].matchedIndex, 0);
});

test('a heuristic-only prompt is detected at the second tier, tagged heuristic with no matched index', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Continue? (y/n) ', stderr: '', code: 0 }));
  const detected: Array<{ origin: string; matchedIndex: number | null }> = [];
  const { scheduleCheck, delays, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    expectedPrompts: ['${TAB3}Enter the Cloudflare API token: '],
    onPromptDetected: (_text, _expected, _write, _resume, origin, matchedIndex) =>
      detected.push({ origin, matchedIndex }),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  assert.equal(detected.length, 0, 'tier 0 tests expected hints only');
  fireLatest();
  await promise;

  assert.deepEqual(delays, [2000, 28000]);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].origin, 'heuristic');
  assert.equal(detected[0].matchedIndex, null);
});

test('output that matches nothing escalates at the third tier, tagged stall', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Configuring the database', stderr: '', code: 0 }));
  const detected: Array<{ text: string; origin: string }> = [];
  const { scheduleCheck, delays, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, _resume, origin) => detected.push({ text, origin }),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  fireLatest();
  assert.equal(detected.length, 0, 'nothing should fire before the stall tier');
  fireLatest();
  await promise;

  assert.deepEqual(delays, [2000, 28000, 270000]);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].origin, 'stall');
  assert.equal(detected[0].text, 'Configuring the database');
});

test('a stall whose output ended in a newline escalates with the last non-empty line, not an empty string', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Installing packages\nWaiting for the service to come up\n', stderr: '', code: 0 }));
  const detected: string[] = [];
  const { scheduleCheck, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, _resume, _origin) => detected.push(text),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  fireLatest();
  fireLatest();
  await promise;

  assert.deepEqual(detected, ['Waiting for the service to come up']);
});

test('no tier is armed at all for a job that never produces output', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const { scheduleCheck, delays } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, { watchForPrompts: true, scheduleCheck });

  await client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');

  // The stall tier is deliberately reachable only after at least one chunk --
  // escalating an empty buffer would show the operator nothing.
  assert.deepEqual(delays, []);
});

test('resume() rewinds to the first tier so the next prompt is not judged at the stall tier', async () => {
  const responses = ['   Proxied? (y/n): ', '   Enable IPv6 support? (y/n): '];
  let call = 0;
  const inner = new FakeSSHClient(() => ({ stdout: responses[call++], stderr: '', code: 0 }));
  const detected: Array<{ origin: string; matchedIndex: number | null }> = [];
  let resumeFn: (() => void) | undefined;
  const { scheduleCheck, delays, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    expectedPrompts: ['${TAB3}Proxied? (y/n): ', '${TAB3}Enable IPv6 support? (y/n): '],
    onPromptDetected: (_text, _expected, _write, resume, origin, matchedIndex) => {
      detected.push({ origin, matchedIndex });
      resumeFn = resume;
    },
    scheduleCheck,
  });

  const promise1 = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  await promise1;
  resumeFn?.();

  const promise2 = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  await promise2;

  assert.deepEqual(detected, [
    { origin: 'expected', matchedIndex: 0 },
    { origin: 'expected', matchedIndex: 1 },
  ]);
  // Three tier-0 arms, not two: resume() itself now arms a fresh tier 0
  // (Finding 1, issue #160) in between the two prompts, on top of the one
  // each exec() call's first chunk arms. The very next exec() call's
  // resetWatchState() cancels that resume-armed check before it can ever
  // fire, but scheduleCheck was still called for it.
  assert.deepEqual(delays, [2000, 2000, 2000], 'both prompts judged from tier 0');
});

test('a pending tier is cancelled on resume, so a stale timer cannot re-pause a resumed job', async () => {
  const inner = new FakeSSHClient(() => ({ stdout: 'Continue? (y/n) ', stderr: '', code: 0 }));
  const detected: string[] = [];
  let resumeFn: (() => void) | undefined;
  const { scheduleCheck, fireLatest } = tieredScheduler();
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, resume) => {
      detected.push(text);
      resumeFn = resume;
    },
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest();
  fireLatest();
  await promise;
  assert.equal(detected.length, 1);

  resumeFn?.();
  // The handle that fired is cancelled by resume(); firing it again must not
  // produce a second detection out of an already-cleared buffer.
  fireLatest();
  assert.equal(detected.length, 1);
});

test('a chunk arriving mid-exec while a higher tier is armed rearms tier 0 and cancels that tier', async () => {
  const detected: Array<{ text: string; origin: string }> = [];
  const { scheduleCheck, delays, pending, fireLatest } = tieredScheduler();
  let onChunk: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  let resolveExec: ((result: ExecResult) => void) | undefined;
  // FakeSSHClient only ever emits one synchronous chunk per exec() call, so
  // this task's central behavior -- a *second* chunk arriving while a higher
  // tier is already armed rewinds detection to tier 0 -- has no fixture that
  // can drive it. This tiny local fake stays pending (like HangingSSHClient)
  // so the test can call onChunk a second time before the exec() resolves.
  const inner: SSHClient = {
    exec: (_target: SshTarget, _command: string, onChunkCb) => {
      onChunk = onChunkCb;
      onChunk?.('Configuring the database', 'stdout');
      return new Promise((resolve) => {
        resolveExec = resolve;
      });
    },
    execInteractive: () => Promise.reject(new Error('not used in this fixture')),
    putFile: () => Promise.resolve(),
  };
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, _resume, origin) => detected.push({ text, origin }),
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');

  // The first chunk arms tier 0. Firing it finds no hint match (mode
  // 'expected' only) and advances to tier 1 -- a higher tier is now armed.
  assert.deepEqual(delays, [2000]);
  fireLatest();
  assert.deepEqual(delays, [2000, 28000]);
  assert.equal(detected.length, 0);

  const armedTier1 = pending[pending.length - 1];
  assert.equal(armedTier1.cancelled, false);

  // A second chunk arrives while tier 1 is still pending. Any new output
  // means the process isn't blocked, so this must rewind to tier 0 -- a
  // fresh 2000ms entry, not a continued climb to a fourth tier.
  onChunk?.('Waiting for the database to accept connections', 'stdout');

  assert.deepEqual(delays, [2000, 28000, 2000]);
  // The tier-1 handle armed before the second chunk must have been
  // cancelled by the rearm -- under the real scheduler this is what a
  // clearTimeout-backed cancel() guarantees can never fire afterward.
  assert.equal(armedTier1.cancelled, true);
  assert.equal(detected.length, 0);

  resolveExec?.({ stdout: '', stderr: '', code: 0 });
  await promise;
});

// Issue #160 Finding 1: resume() used to arm nothing, so a dismissed false
// positive followed by no further output left the watchdog permanently
// disarmed -- the exact thing the stall tier exists to prevent, reached via
// its own Dismiss button. These two tests cover the fix: resume() re-arms
// a tier even with no further output (and the eventual stall fallback is
// never a blank banner), and output that arrives *during* a pause is
// retained rather than dropped.

test('resume() re-arms the watchdog even with no further output, and the stall tier falls back to the last fired prompt text rather than an empty banner', async () => {
  const detected: Array<{ text: string; origin: string }> = [];
  const { scheduleCheck, delays, fireLatest } = tieredScheduler();
  let resumeFn: (() => void) | undefined;
  let resolveExec: ((result: ExecResult) => void) | undefined;
  // Stays pending like the mid-exec fixture above, so resume() can be
  // exercised without the exec() call completing out from under it.
  const inner: SSHClient = {
    exec: (_target: SshTarget, _command: string, onChunkCb) => {
      onChunkCb?.('Continue? (y/n) ', 'stdout');
      return new Promise((resolve) => {
        resolveExec = resolve;
      });
    },
    execInteractive: () => Promise.reject(new Error('not used in this fixture')),
    putFile: () => Promise.resolve(),
  };
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    onPromptDetected: (text, _expected, _write, resume, origin) => {
      detected.push({ text, origin });
      resumeFn = resume;
    },
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  // Tier 0 finds no expected-hint match (none configured), arms tier 1,
  // which matches the (y/n) heuristic and fires -- a false positive the
  // operator dismisses below.
  fireLatest();
  fireLatest();
  assert.equal(detected.length, 1);
  assert.equal(detected[0].origin, 'heuristic');

  // The operator dismisses, and the script never prints anything else --
  // under the pre-fix code this is exactly where the watchdog went
  // permanently silent, since resume() armed nothing.
  resumeFn?.();

  // Three more fires walk tier 0 -> tier 1 -> tier 2 with an empty buffer
  // the whole way, proving resume() actually re-armed the chain rather
  // than leaving it dead.
  fireLatest();
  fireLatest();
  fireLatest();

  assert.deepEqual(delays, [2000, 28000, 2000, 28000, 270000]);
  assert.equal(detected.length, 2);
  assert.equal(detected[1].origin, 'stall');
  // Not an empty escalation -- falls back to the text that fired the
  // dismissed prompt, labelled as stale rather than presented as fresh.
  assert.equal(detected[1].text, '(no new output since last seen) Continue? (y/n) ');

  resolveExec?.({ stdout: '', stderr: '', code: 0 });
  await promise;
});

test('output arriving during a pause is retained and visible to the matcher after resume()', async () => {
  const detected: Array<{ text: string; origin: string }> = [];
  const { scheduleCheck, fireLatest } = tieredScheduler();
  let onChunk: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  let resumeFn: (() => void) | undefined;
  let resolveExec: ((result: ExecResult) => void) | undefined;
  const inner: SSHClient = {
    exec: (_target: SshTarget, _command: string, onChunkCb) => {
      onChunk = onChunkCb;
      onChunk?.('Continue? (y/n) ', 'stdout');
      return new Promise((resolve) => {
        resolveExec = resolve;
      });
    },
    execInteractive: () => Promise.reject(new Error('not used in this fixture')),
    putFile: () => Promise.resolve(),
  };
  const client = new JobSSHClient(inner, () => {}, undefined, {
    watchForPrompts: true,
    expectedPrompts: ['${TAB3}Enter the API token: '],
    onPromptDetected: (text, _expected, _write, resume, origin) => {
      detected.push({ text, origin });
      resumeFn = resume;
    },
    scheduleCheck,
  });

  const promise = client.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
  fireLatest(); // tier 0: no expected-hint match -> arms tier 1
  fireLatest(); // tier 1: (y/n) heuristic matches -> fires (a false positive)
  assert.equal(detected.length, 1);
  assert.equal(detected[0].origin, 'heuristic');

  // While the job sits paused awaiting the operator's decision, the script
  // keeps running and hits its own real prompt. Under the pre-fix code
  // watchChunk's `if (this.paused) return;` guard dropped this chunk
  // entirely, before it ever reached the buffer.
  onChunk?.('   Enter the API token: ', 'stdout');

  // The operator dismisses the false positive.
  resumeFn?.();

  // The fresh tier 0 check armed by resume() must see the retained text,
  // not an empty buffer.
  fireLatest();

  assert.equal(detected.length, 2);
  assert.equal(detected[1].origin, 'expected');
  assert.equal(detected[1].text, '   Enter the API token: ');

  resolveExec?.({ stdout: '', stderr: '', code: 0 });
  await promise;
});
