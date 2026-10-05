import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCapturedConsole } from '../../src/web/console-capture.ts';
import { gate } from '../support/gate.ts';

test('captures console.log/console.error output and restores the originals', async () => {
  const origLog = console.log;
  const { text, result } = await withCapturedConsole(async () => {
    console.log('hello');
    console.error('warn: careful');
    return 42;
  });
  assert.equal(text, 'hello\nwarn: careful');
  assert.equal(result, 42);
  assert.equal(console.log, origLog);
});

test('calls onLine synchronously as each line is captured', async () => {
  const seen: string[] = [];
  await withCapturedConsole(async () => {
    console.log('one');
    console.log('two');
  }, (line) => seen.push(line));
  assert.deepEqual(seen, ['one', 'two']);
});

test('two concurrent calls never interleave — each only sees its own lines', async () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runA = withCapturedConsole(async () => {
    console.log('A1');
    await delay(20);
    console.log('A2');
  });
  const runB = withCapturedConsole(async () => {
    console.log('B1');
  });
  const [a, b] = await Promise.all([runA, runB]);
  assert.equal(a.text, 'A1\nA2');
  assert.equal(b.text, 'B1');
});

// Swaps console.log for a collector for the duration of `fn` (before any
// capture starts, so the capture saves the collector as its fallback), and
// restores both console functions however `fn` ends.
async function withCollector(fn: (collected: string[], origError: typeof console.error) => Promise<void>): Promise<void> {
  const origLog = console.log;
  const origError = console.error;
  const collected: string[] = [];
  console.log = (...args: unknown[]) => {
    collected.push(args.map(String).join(' '));
  };
  try {
    await fn(collected, origError);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test('a capture does not wait for another capture that is still running (#78)', { timeout: 5000 }, async () => {
  const release = gate();
  const runA = withCapturedConsole(async () => {
    console.log('A1');
    await release.promise;
    console.log('A2');
  });
  const b = await withCapturedConsole(async () => {
    console.log('B1');
    return 'b';
  });
  assert.equal(b.text, 'B1');
  assert.equal(b.result, 'b');
  release.open();
  const a = await runA;
  assert.equal(a.text, 'A1\nA2');
});

test('a nested capture gets the inner lines; the outer keeps only its own (#78)', { timeout: 5000 }, async () => {
  const innerSeen: string[] = [];
  const outerSeen: string[] = [];
  let inner: { text: string; result: number } | undefined;
  const outer = await withCapturedConsole(async () => {
    console.log('outer before');
    inner = await withCapturedConsole(async () => {
      console.log('inner one');
      console.error('inner two');
      return 7;
    }, (line) => innerSeen.push(line));
    console.log('outer after');
  }, (line) => outerSeen.push(line));
  assert.equal(inner?.text, 'inner one\ninner two');
  assert.equal(inner?.result, 7);
  assert.deepEqual(innerSeen, ['inner one', 'inner two']);
  assert.equal(outer.text, 'outer before\nouter after');
  assert.deepEqual(outerSeen, ['outer before', 'outer after']);
});

test('lines from timer and EventEmitter callbacks scheduled inside a capture land in that capture only (#78)', { timeout: 5000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const aCallbacksDone = gate();
  const bCallbacksDone = gate();

  // Each capture schedules a timer and an EventEmitter emission (from a
  // setImmediate scheduled inside the capture), then waits until both its
  // own callbacks and the other capture's have fired before finishing, so
  // all four callbacks fire while both captures are running.
  const scheduleCallbacks = (name: string, done: () => void) => {
    let pending = 2;
    const fired = () => {
      pending -= 1;
      if (pending === 0) done();
    };
    setTimeout(() => {
      console.log(`${name} timer`);
      fired();
    }, 0);
    const emitter = new EventEmitter();
    emitter.on('ready', () => {
      console.log(`${name} emitter`);
      fired();
    });
    setImmediate(() => emitter.emit('ready'));
  };

  const runA = withCapturedConsole(async () => {
    scheduleCallbacks('A', aCallbacksDone.open);
    await Promise.all([aCallbacksDone.promise, bCallbacksDone.promise]);
  });
  const runB = withCapturedConsole(async () => {
    scheduleCallbacks('B', bCallbacksDone.open);
    await Promise.all([aCallbacksDone.promise, bCallbacksDone.promise]);
  });
  const [a, b] = await Promise.all([runA, runB]);
  assert.deepEqual(a.text.split('\n').sort(), ['A emitter', 'A timer']);
  assert.deepEqual(b.text.split('\n').sort(), ['B emitter', 'B timer']);
});

test('a line logged after its capture settled goes to the fallback console, even while another capture runs (#78)', { timeout: 5000 }, async () => {
  await withCollector(async (collected) => {
    const late = gate();
    const lateLogged = gate();
    const releaseB = gate();
    const aSeen: string[] = [];

    const runB = withCapturedConsole(async () => {
      console.log('B1');
      await releaseB.promise;
    });
    const a = await withCapturedConsole(async () => {
      console.log('A1');
      // Registered inside A, so it runs in A's async context -- but only
      // after A has settled.
      void late.promise.then(() => {
        console.log('A late');
        lateLogged.open();
      });
    }, (line) => aSeen.push(line));

    late.open();
    await lateLogged.promise;
    releaseB.open();
    const b = await runB;

    assert.equal(a.text, 'A1');
    assert.deepEqual(aSeen, ['A1']);
    assert.equal(b.text, 'B1');
    assert.deepEqual(collected, ['A late']);
  });
});

test('console.log replaced during a capture stays replaced after the capture ends (restore-only-if-still-installed, #78)', async () => {
  const origLog = console.log;
  const origError = console.error;
  const collected: string[] = [];
  const replacement = (...args: unknown[]) => {
    collected.push(args.map(String).join(' '));
  };
  try {
    await withCapturedConsole(async () => {
      console.log('before replace');
      // Replaces console.log mid-capture, directly, the way a library
      // outside this module's control might -- uninstall() must not stomp
      // this back to the fallback once the capture ends.
      console.log = replacement;
    });
    assert.strictEqual(console.log, replacement);
    console.log('after capture');
    assert.deepEqual(collected, ['after capture']);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

// H1 regression: install() must not capture its own wrapper as the
// fallback. Sequence: a capture is active (console.log is logWrapper); code
// saves that reference and replaces console.log with its own collector;
// the capture ends (uninstall() correctly leaves the collector in place,
// per the test above); the saved reference is then reassigned back onto
// console.log, so console.log is logWrapper again -- but not because
// install() put it there. A second capture then starts while console.log is
// already logWrapper: the unguarded install() used to re-snapshot that as
// its own fallback, so the next line logged outside any capture recursed
// into logWrapper forever (a stack overflow). The real pre-test console.log
// is temporarily replaced with a collector before the whole sequence so we
// can assert the fallback chain still reaches *it* at the end.
test('install() does not capture its own wrapper as the fallback when a saved wrapper reference is reassigned back onto console.log (#78, H1)', async () => {
  const origLog = console.log;
  const origError = console.error;
  const finalCollected: string[] = [];
  console.log = (...args: unknown[]) => finalCollected.push(args.map(String).join(' '));

  try {
    let savedWrapper: typeof console.log | undefined;
    const collectedWhileOverridden: string[] = [];
    const override = (...args: unknown[]) => {
      collectedWhileOverridden.push(args.map(String).join(' '));
    };

    await withCapturedConsole(async () => {
      // console.log is logWrapper here (the capture just started). Some
      // code saves that reference, believing it's saving "the original"...
      savedWrapper = console.log;
      // ...then installs its own replacement mid-capture.
      console.log = override;
    });
    // The capture has settled; uninstall() found console.log !== logWrapper
    // (it's the override above) and correctly left it alone.
    assert.strictEqual(console.log, override);

    // The saved reference is reassigned back onto console.log -- it's
    // actually logWrapper, not "the original".
    console.log = savedWrapper!;
    assert.equal(console.log, savedWrapper);

    // A second capture starts while console.log is already logWrapper.
    const b = await withCapturedConsole(async () => {
      console.log('inside B');
    });
    assert.equal(b.text, 'inside B');

    // Logged after the second capture settled, with no active capture --
    // must reach the fallback console without recursing/throwing, and the
    // fallback must be the real pre-test console, not logWrapper itself.
    console.log('outside after B');
    assert.deepEqual(finalCollected, ['outside after B']);
    // The override was swapped out before anything was logged, so no line
    // in this sequence reached it.
    assert.deepEqual(collectedWhileOverridden, []);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

test('outside-capture lines reach the console in place when the capture started, which is restored afterwards (MCP redirect, #78)', { timeout: 5000 }, async () => {
  await withCollector(async (collected, origError) => {
    const collector = console.log;
    const insideStarted = gate();
    const release = gate();

    const runA = withCapturedConsole(async () => {
      console.log('A1');
      insideStarted.open();
      await release.promise;
      console.log('A2');
    });
    // The concurrent sibling: no capture of its own, so its line must go to
    // the collector (the MCP server's stderr redirect in production), not
    // into A.
    const sibling = (async () => {
      await insideStarted.promise;
      console.log('outside');
      release.open();
    })();
    const [a] = await Promise.all([runA, sibling]);

    assert.equal(a.text, 'A1\nA2');
    assert.deepEqual(collected, ['outside']);
    assert.equal(console.log, collector);
    assert.equal(console.error, origError);
  });
});

test('a capture started after console.log was replaced mid-capture still captures, and the replacement becomes the fallback (#78)', { timeout: 5000 }, async () => {
  const origLog = console.log;
  const origError = console.error;
  const collected: string[] = [];
  const collector = (...args: unknown[]) => {
    collected.push(args.map(String).join(' '));
  };
  const aStarted = gate();
  const releaseA = gate();
  try {
    const runA = withCapturedConsole(async () => {
      aStarted.open();
      await releaseA.promise;
    });
    await aStarted.promise;
    // Replaced while A is still active, e.g. by a test or library.
    console.log = collector;

    const b = await withCapturedConsole(async () => {
      console.log('inside B');
    });
    assert.equal(b.text, 'inside B');
    assert.deepEqual(collected, []);

    console.log('outside after B');
    assert.deepEqual(collected, ['outside after B']);

    releaseA.open();
    const a = await runA;
    assert.equal(a.text, '');
    assert.equal(console.log, collector);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});
