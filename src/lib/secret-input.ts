import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// How the CLI's set-config reads a secret without it ever being an argument
// (issue #64, contracts/cli.md). Both take their streams as parameters so
// tests can drive them without touching the real terminal.

// Reads standard input to the end, for `set-config <key> --stdin`.
export async function readAllStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Asks one question and reads one line without echoing what is typed: the
// question goes to `output`, then everything readline would write back (the
// typed characters) is swallowed. The prompt goes to stderr by default so
// stdout carries only the command's own result lines.
export function promptHidden(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const echo = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) output.write(chunk);
        callback();
      },
    });
    // Set once the promise settles, so the 'close' every path below ends
    // in only rejects when nothing else has.
    let settled = false;
    const rl = createInterface({ input, output: echo, terminal: true });
    rl.on('SIGINT', () => {
      settled = true;
      rl.close();
      output.write('\n');
      reject(new Error('Cancelled'));
    });
    // The input ended (Ctrl+D, or a closed pipe) before a line was entered:
    // without this the promise would never settle and set-config would
    // hang instead of exiting.
    rl.on('close', () => {
      if (settled) return;
      settled = true;
      output.write('\n');
      reject(new Error('Cancelled -- nothing was written'));
    });
    rl.question(question, (answer) => {
      settled = true;
      rl.close();
      output.write('\n');
      resolve(answer);
    });
    // rl.question writes the question synchronously, so everything after
    // this point is the typed answer being echoed back.
    muted = true;
  });
}
