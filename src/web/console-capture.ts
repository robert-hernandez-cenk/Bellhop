import { AsyncLocalStorage } from 'node:async_hooks';

// Captures console.log/console.error output produced by `fn` (#78).
//
// Each capture runs `fn` inside its own AsyncLocalStorage context, so every
// line logged from `fn` -- and from anything it awaits or schedules while it
// runs: timers, promise callbacks, socket/SSH channel events -- reaches that
// capture's sink and no other. Captures therefore run concurrently instead of
// one at a time, and a nested capture gets the inner lines only.
//
// The console wrappers are installed by reference count rather than once at
// module load: when the first concurrent capture starts, whatever
// console.log/console.error are at that moment are saved as the fallback for
// lines logged outside any capture, and they are put back when the last
// capture ends -- but only if the wrappers are still the ones installed, so
// code that replaced the console in between keeps its replacement. Two
// reasons for this:
//   - src/mcp/server.ts sets `console.log = console.error` in its module body,
//     which runs after every import is evaluated. Wrappers installed at import
//     time would be overwritten there and MCP job output would go to stderr
//     instead of the job log; installed at first capture, that redirect
//     becomes the fallback instead, keeping stdout clean.
//   - Many tests swap console.log for a collector and restore it afterwards.
//     Restoring at count 0 keeps the console exactly what it was whenever no
//     capture is running. That alone doesn't stop code from saving
//     console.log *while a capture is active* (capturing logWrapper itself),
//     installing its own replacement, and later reassigning that saved
//     reference back onto console.log once the capture has ended -- at that
//     point console.log is logWrapper again, but not because install() put
//     it there. install() below guards against exactly this: it only takes a
//     new fallback snapshot when console.log/console.error aren't already
//     its own wrapper functions, so a stray wrapper reintroduced this way is
//     never captured as its own fallback -- which would otherwise make every
//     later outside-capture log recurse into logWrapper/errorWrapper forever.

interface CaptureSink {
  lines: string[];
  onLine?: (line: string) => void;
  // Cleared once the capture's fn settles: a timer or socket callback that
  // outlives the capture goes to the fallback console instead of being
  // appended to a finished capture (or a finished job's log).
  active: boolean;
}

type ConsoleFn = (...args: unknown[]) => void;

const storage = new AsyncLocalStorage<CaptureSink>();
let activeCaptures = 0;
let fallbackLog: ConsoleFn = console.log;
let fallbackError: ConsoleFn = console.error;

function wrap(fallback: () => ConsoleFn): ConsoleFn {
  return (...args: unknown[]) => {
    const sink = storage.getStore();
    if (sink?.active) {
      const line = args.map(String).join(' ');
      sink.lines.push(line);
      sink.onLine?.(line);
      return;
    }
    fallback()(...args);
  };
}

const logWrapper = wrap(() => fallbackLog);
const errorWrapper = wrap(() => fallbackError);

function install(): void {
  if (activeCaptures === 0) {
    // Only take a new snapshot when console.log/console.error aren't already
    // our own wrapper functions -- see the header comment above for the
    // sequence this guards against (a saved wrapper reference reassigned
    // back onto console.log after a capture ended, which would otherwise be
    // captured here as its own fallback and recurse forever the next time a
    // line is logged outside any capture).
    if (console.log !== logWrapper) fallbackLog = console.log;
    if (console.error !== errorWrapper) fallbackError = console.error;
    console.log = logWrapper;
    console.error = errorWrapper;
  }
  activeCaptures += 1;
}

function uninstall(): void {
  activeCaptures -= 1;
  if (activeCaptures === 0) {
    if (console.log === logWrapper) console.log = fallbackLog;
    if (console.error === errorWrapper) console.error = fallbackError;
  }
}

export async function withCapturedConsole<T>(
  fn: () => Promise<T>,
  onLine?: (line: string) => void
): Promise<{ text: string; result: T }> {
  const sink: CaptureSink = { lines: [], onLine, active: true };
  install();
  try {
    const result = await storage.run(sink, fn);
    return { text: sink.lines.join('\n'), result };
  } finally {
    sink.active = false;
    uninstall();
  }
}
