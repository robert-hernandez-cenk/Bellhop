import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCapturedConsole } from '../../src/web/console-capture.ts';

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

// Test-controlled gates (constitution Principle III): every ordering below is
// forced by resolving one of these, never by a wall-clock wait.
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

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
