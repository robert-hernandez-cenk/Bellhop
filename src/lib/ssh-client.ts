import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Same lookup order as a plain ssh client's default IdentityFile resolution.
const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

// `home` is injectable purely so this and resolvePrivateKey() below are
// testable against a fixture directory without mutating HOME/USERPROFILE.
// Production always takes the default.
function defaultPrivateKey(home: string = homedir()): Buffer | undefined {
  const sshDir = join(home, '.ssh');
  for (const name of DEFAULT_IDENTITY_FILES) {
    const path = join(sshDir, name);
    if (existsSync(path)) return readFileSync(path);
  }
  return undefined;
}

// Resolves a host's ssh_identity_file to a real path, in this order:
//   1. a leading "~" is replaced with the home directory, and the result
//      returned -- so "~/keys/pve" lands at <home>/keys/pve, NOT under .ssh;
//   2. otherwise a value containing no path separator (neither "/" nor "\",
//      since this toolkit runs on Windows) is a bare key name relative to
//      <home>/.ssh/ -- "pve_key" means "~/.ssh/pve_key", which is how
//      operators actually think about key names;
//   3. otherwise it is an ordinary path, a relative one resolved against cwd
//      the same way every other path this toolkit accepts is.
export function resolveIdentityPath(identityFile: string, home: string = homedir()): string {
  if (identityFile === '~') return home;
  if (identityFile.startsWith('~/') || identityFile.startsWith('~\\')) {
    return resolve(home, identityFile.slice(2));
  }
  if (!identityFile.includes('/') && !identityFile.includes('\\')) {
    return join(home, '.ssh', identityFile);
  }
  return resolve(identityFile);
}

// An explicitly configured per-host key must exist: a per-host override is a
// deliberate operator statement, and silently falling back to the global
// lookup (or an agent) would authenticate with a different key than the one
// named, surfacing much later as an opaque "All configured authentication
// methods failed" from the remote sshd. Failing here names the actual
// mistake. Returns undefined only in the no-override, no-default-key case,
// which connectConfig() reads as "fall back to the agent".
export function resolvePrivateKey(target: SshTarget, home: string = homedir()): Buffer | undefined {
  if (!target.identityFile) return defaultPrivateKey(home);
  const path = resolveIdentityPath(target.identityFile, home);
  try {
    return readFileSync(path);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new Error(`SSH identity file for ${target.host} is unreadable: ${path} (${reason})`, { cause: err });
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Everything needed to open one SSH connection. Collapses what used to be
// two leading positional strings on every SSHClient method so per-host port
// and identity-file settings have somewhere to travel -- see
// hostSshTarget() in targets.ts, the single place an inventory entry is
// mapped onto this.
export interface SshTarget {
  host: string;
  user: string;
  // Omitted means ssh2's own default of 22.
  port?: number;
  // Omitted means the global ~/.ssh/id_ed25519 -> id_ecdsa -> id_rsa lookup.
  identityFile?: string;
}

export interface SSHClient {
  exec(
    target: SshTarget,
    command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    // Opt-in: when supplied, exec() leaves the channel's stdin open instead
    // of its default immediate stream.end(), and calls this synchronously
    // (right after the channel opens) with a `write` function tied to that
    // channel -- used by the web job runner to watch for and answer an
    // app-specific interactive prompt live (see issue #57). Every existing
    // caller omits this and gets today's immediate-EOF behavior unchanged.
    // Supplying it also now requests a real pty (the same mechanism
    // execInteractive() below uses), since a remote `read -p` only ever
    // writes its prompt text to the terminal when the shell is interactive
    // -- without a pty there is nothing for the prompt-detection heuristic
    // to see in the first place. This inherits execInteractive()'s same
    // stdout/stderr-merge tradeoff: a pty has no separate stream.stderr, so
    // ExecResult.stderr stays '' for a watched exec.
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult>;
  // Opt-in interactive mode: requests a remote pty and pipes local
  // process.stdin/stdout straight through for the duration of the command,
  // so any prompt the remote command shows (known or not) can be answered
  // live -- used only by install-app's CLI action when attached to a real
  // terminal (see issue #56). No onChunk/signal params: there is no
  // web-job-runner streaming or externally supplied AbortSignal use case
  // here, cancellation is local (Ctrl+C) instead. A real pty merges
  // remote stdout/stderr into one stream, so ExecResult.stderr is always
  // '' -- all output lands in stdout, matching what a human at a live
  // terminal actually sees.
  execInteractive(target: SshTarget, command: string): Promise<ExecResult>;
  // Writes content to remotePath on target via SFTP -- used for
  // transferring binary payloads too large to safely embed in a single
  // exec command string (Linux caps a single exec argv element at 128KB;
  // see deploy-vpn-gateway.ts's use of this for the ~9-10MB
  // vpn-gateway-agent binary). Overwrites any existing file at remotePath.
  putFile(target: SshTarget, remotePath: string, content: Buffer): Promise<void>;
}

// Thrown by execInteractive() when the operator cancels locally via Ctrl+C
// -- distinct from a generic Error so callers (runInstallApp) can catch it
// specifically and warn about a possibly partially-created remote guest,
// rather than reporting it as an ordinary command failure.
export class InteractiveCancelledError extends Error {
  constructor() {
    super('Cancelled locally via Ctrl+C');
    this.name = 'InteractiveCancelledError';
  }
}

// POSIX single-quote escaping: the safe equivalent of bash's printf '%q' for
// forwarding a command string to a remote shell.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class Ssh2SSHClient implements SSHClient {
  // The single place a SshTarget becomes ssh2 connection options -- exec(),
  // execInteractive(), and putFile() previously each carried their own
  // identical copy of this block.
  private connectConfig(target: SshTarget): ConnectConfig {
    const privateKey = resolvePrivateKey(target);
    return {
      host: target.host,
      username: target.user,
      // Spread in only when set, rather than `target.port ?? 22`, so ssh2
      // keeps owning its own default instead of this file holding a second
      // copy of it.
      ...(target.port ? { port: target.port } : {}),
      // Prefer reading an identity file directly, the same way a plain
      // ssh/git-bash client authenticates when no agent is running. Falls
      // back to an agent (Pageant on Windows, SSH_AUTH_SOCK elsewhere) only
      // when no key file is found -- note resolvePrivateKey() throws rather
      // than reaching here when the host names an ssh_identity_file that
      // cannot be read.
      ...(privateKey
        ? { privateKey }
        : { agent: process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK }),
      readyTimeout: 5000,
    };
  }

  exec(
    target: SshTarget,
    command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Job cancelled'));
        return;
      }
      const conn = new Client();
      // Set once the operator cancels the job (Job History's Stop button)
      // while this exec is in flight -- ends the connection early and, once
      // 'close' fires as a result, rejects instead of resolving so a
      // cancelled command is never mistaken for one that actually completed.
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        conn.end();
      };
      signal?.addEventListener('abort', onAbort);
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      conn
        .on('ready', () => {
          // Bash's `read -p` only ever writes its prompt text to the
          // terminal when the shell is interactive, which requires a real
          // pty -- confirmed live: piping input to a non-tty `read -p`
          // silently reads the answer with the prompt text never
          // appearing on stdout or stderr at all. A caller that supplies
          // onStdinReady wants to watch for and answer a live prompt
          // (issue #57's install-app job watcher), so that case requests
          // a pty here -- the same mechanism execInteractive() already
          // uses for the CLI's interactive mode -- so the prompt text
          // actually reaches onChunk. Every other caller (no
          // onStdinReady) keeps today's plain, non-pty exec unchanged.
          const execCallback = (err: Error | undefined, stream: ClientChannel) => {
            if (err) {
              cleanup();
              conn.end();
              reject(err);
              return;
            }
            // Nothing writes to the remote command's stdin by default --
            // left open, a stray interactive `read` on the remote side (a
            // bash prompt, or an app-level prompt baked into a
            // community-scripts installer script) blocks forever waiting
            // for input that can never arrive, and this exec() call never
            // resolves. Closing it immediately turns that into an
            // immediate EOF instead. A caller that supplies onStdinReady
            // wants the opposite -- e.g. install-app's web job watching for
            // a prompt to answer live (issue #57) -- so stdin is left open
            // and a live writer handed back instead of being closed.
            if (onStdinReady) {
              onStdinReady((text) => stream.write(text));
            } else {
              stream.end();
            }
            let stdout = '';
            let stderr = '';
            // A multi-byte UTF-8 character (e.g. box-drawing glyphs from a
            // progress bar, an accented package name) can land split across
            // two separate 'data' events -- Buffer#toString() decodes each
            // chunk in isolation and would turn the split character into
            // mangled replacement bytes. StringDecoder buffers a trailing
            // incomplete sequence until the rest of it arrives.
            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            stream
              // ssh2 calls this with (code, signal): code is a real exit
              // status on a normal exit, but null when the remote process
              // was instead terminated by a signal (killed, OOM, crashed)
              // -- `code ?? 0` used to coerce that into a *successful* exit,
              // silently reporting a killed remote command as having
              // succeeded (discovered when killing a hung remote `whiptail`
              // made install-app believe the install had completed and
              // write a phantom guest into inventory). A signal-terminated
              // command is never a success, regardless of what stdout looks
              // like.
              .on('close', (code: number | null, signal?: string) => {
                cleanup();
                conn.end();
                const stdoutTail = stdoutDecoder.end();
                const stderrTail = stderrDecoder.end();
                if (stdoutTail) {
                  stdout += stdoutTail;
                  onChunk?.(stdoutTail, 'stdout');
                }
                if (stderrTail) {
                  stderr += stderrTail;
                  onChunk?.(stderrTail, 'stderr');
                }
                if (cancelled) {
                  reject(new Error('Job cancelled'));
                  return;
                }
                if (code === null) {
                  resolve({
                    stdout,
                    stderr: stderr || `Remote command terminated by signal${signal ? ` (${signal})` : ''}, not a normal exit`,
                    code: 1,
                  });
                  return;
                }
                resolve({ stdout, stderr, code });
              })
              .on('data', (data: Buffer) => {
                const text = stdoutDecoder.write(data);
                if (!text) return;
                stdout += text;
                onChunk?.(text, 'stdout');
              });
            // A pty merges remote stdout/stderr into one stream -- there is
            // no separate stream.stderr to read in that mode (see
            // execInteractive()'s identical comment/behavior). stderr
            // stays '' for a watched exec, same tradeoff #56 already
            // accepted.
            if (!onStdinReady) {
              stream.stderr.on('data', (data: Buffer) => {
                const text = stderrDecoder.write(data);
                if (!text) return;
                stderr += text;
                onChunk?.(text, 'stderr');
              });
            }
          };
          if (onStdinReady) {
            conn.exec(command, { pty: true }, execCallback);
          } else {
            conn.exec(command, execCallback);
          }
        })
        .on('error', (err) => {
          cleanup();
          if (cancelled) {
            reject(new Error('Job cancelled'));
            return;
          }
          reject(err);
        })
        .connect(this.connectConfig(target));
    });
  }

  // Opt-in interactive counterpart to exec() -- requests a real pty,
  // pipes local process.stdin straight to the remote command, and streams
  // its output straight to process.stdout, while still accumulating into
  // the same ExecResult contract exec() returns. No automated test: like
  // exec()/putFile(), this opens a real SSH connection and terminal
  // session and is verified live against real infrastructure.
  execInteractive(target: SshTarget, command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      // Set when the operator hits Ctrl+C locally -- unlike exec()'s
      // AbortSignal-driven cancellation (the web job runner's Stop
      // button), this is detected directly on the piped stdin stream
      // since there is no external signal source for a CLI session.
      let cancelled = false;
      let rawModeEnabled = false;
      let stdinListener: ((data: Buffer) => void) | undefined;
      // The exec channel's own 'close' and the connection's 'close' can
      // both plausibly fire for the same disconnect -- settled guards
      // against trying to resolve/reject twice.
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // A broken connection must never leave the operator's terminal
      // stuck in raw mode -- this runs on every exit path (exec error,
      // conn error before ready, conn close, and both branches of the
      // stream 'close' handler below).
      const restoreStdin = () => {
        if (stdinListener) {
          process.stdin.off('data', stdinListener);
          stdinListener = undefined;
        }
        if (rawModeEnabled && process.stdin.isTTY) {
          process.stdin.setRawMode(false);
          rawModeEnabled = false;
        }
        process.stdin.pause();
      };

      conn
        .on('ready', () => {
          // pty:true allocates a remote pseudo-tty -- this is what makes
          // any remote prompt (a plain `read`, a whiptail dialog) behave
          // like a real interactive ssh session instead of erroring or
          // hanging for lack of one. Unlike exec()'s stdin handling, this
          // deliberately never calls stream.end(): stdin stays open and
          // is piped from process.stdin for the life of the command.
          conn.exec(command, { pty: true }, (err, stream) => {
            if (err) {
              restoreStdin();
              conn.end();
              settle(() => reject(err));
              return;
            }
            let stdout = '';
            const stdoutDecoder = new StringDecoder('utf8');

            if (process.stdin.isTTY) {
              process.stdin.setRawMode(true);
              rawModeEnabled = true;
            }
            process.stdin.resume();
            stdinListener = (data: Buffer) => {
              // 0x03 is Ctrl+C -- intercepted locally rather than
              // forwarded, so the operator cancels the CLI's own
              // connection instead of relying on the remote process's
              // SIGINT handling.
              if (data.includes(0x03)) {
                cancelled = true;
                restoreStdin();
                conn.end();
                return;
              }
              // The remote command can exit between a keystroke landing
              // and restoreStdin() unhooking this listener -- writing to
              // an already-ended channel would otherwise throw.
              if (stream.writable) stream.write(data);
            };
            process.stdin.on('data', stdinListener);

            stream
              // Belt-and-suspenders for the writable check above: a write
              // can still race the channel closing. There is nothing more
              // useful to do with a write-after-close error than swallow
              // it -- the 'close' handler below is what actually settles
              // the promise.
              .on('error', () => {})
              // Same signal-vs-real-exit-code distinction exec() already
              // has (see its own 'close' handler comment) -- a
              // signal-terminated command is never a success.
              .on('close', (code: number | null, signal?: string) => {
                restoreStdin();
                conn.end();
                const stdoutTail = stdoutDecoder.end();
                if (stdoutTail) {
                  stdout += stdoutTail;
                  process.stdout.write(stdoutTail);
                }
                if (cancelled) {
                  settle(() => reject(new InteractiveCancelledError()));
                  return;
                }
                if (code === null) {
                  settle(() =>
                    resolve({
                      stdout,
                      stderr: `Remote command terminated by signal${signal ? ` (${signal})` : ''}, not a normal exit`,
                      code: 1,
                    })
                  );
                  return;
                }
                // pty:true merges remote stdout/stderr into one stream --
                // there is no separate stream.stderr data to read here,
                // so stderr is always '' (see Global Constraints).
                settle(() => resolve({ stdout, stderr: '', code }));
              })
              .on('data', (data: Buffer) => {
                const text = stdoutDecoder.write(data);
                if (!text) return;
                stdout += text;
                process.stdout.write(text);
              });
          });
        })
        .on('error', (err) => {
          restoreStdin();
          settle(() => reject(cancelled ? new InteractiveCancelledError() : err));
        })
        // A clean disconnect (remote sshd restart, network drop) can close
        // the connection without ever emitting 'error' -- without this,
        // the promise would never settle and the operator's terminal
        // would be left stuck in raw mode with stdin still resumed.
        .on('close', () => {
          restoreStdin();
          settle(() =>
            reject(cancelled ? new InteractiveCancelledError() : new Error('SSH connection closed unexpectedly'))
          );
        })
        .connect(this.connectConfig(target));
    });
  }

  // Shares connectConfig() with exec()/execInteractive() so it authenticates
  // identically -- the only difference is opening an SFTP subsystem instead
  // of an exec channel. Like exec(), this method has no automated test: it
  // is the only other place in the codebase that opens a real SSH
  // connection, and is verified live rather than mocked.
  putFile(target: SshTarget, remotePath: string, content: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn
        .on('ready', () => {
          conn.sftp((err, sftp) => {
            if (err) {
              conn.end();
              reject(err);
              return;
            }
            const stream = sftp.createWriteStream(remotePath);
            stream.on('error', (streamErr: Error) => {
              conn.end();
              reject(streamErr);
            });
            stream.on('close', () => {
              conn.end();
              resolve();
            });
            stream.end(content);
          });
        })
        .on('error', (err) => reject(err))
        .connect(this.connectConfig(target));
    });
  }
}
