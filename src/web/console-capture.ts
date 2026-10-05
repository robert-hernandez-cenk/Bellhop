import { AsyncLocalStorage } from 'node:async_hooks';

// Captures console.log/console.error output produced by `fn` (#78).
//
// Each capture runs `fn` inside its own AsyncLocalStorage context, so every
// line logged from `fn` -- and from anything it awaits or schedules while it
// runs: timers, promise callbacks, socket/SSH channel events -- reaches that
// capture's sink and no other. Captures therefore run concurrently instead of
// one at a time, and a nested capture gets the inner lines only.
//
// The console wrappers are installed when a capture starts, not at module
// load. Every capture start checks console.log and console.error separately:
// if one is not our wrapper, it becomes the fallback for lines logged outside
// any capture and the wrapper is put (back) in its place. So a console
// replaced while a capture is active is captured again by the next capture.
// When the last active capture ends, each fallback is restored, but only if
// our wrapper is still installed, so a replacement made since stays. Two
// reasons for this:
//   - src/mcp/server.ts sets `console.log = console.error` in its module body,
//     which runs after every import is evaluated. Wrappers installed at import
//     time would be overwritten there and MCP job output would go to stderr
//     instead of the job log; installed at capture start, that redirect
//     becomes the fallback instead, keeping stdout clean.
//   - Many tests swap console.log for a collector and restore it afterwards.
//
// The fallback is only ever taken from a console function that is not our
// wrapper, so code that saved a wrapper and assigns it back later can never
// make an outside-capture line recurse into the wrapper forever.

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
  // Runs on every capture start, not only the first (see the header).
  if (console.log !== logWrapper) {
    fallbackLog = console.log;
    console.log = logWrapper;
  }
  if (console.error !== errorWrapper) {
    fallbackError = console.error;
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
