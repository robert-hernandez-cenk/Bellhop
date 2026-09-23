import type { ExecResult, SSHClient, SshTarget } from '../../src/lib/ssh-client.ts';

// Deliberately still (sshTarget, sshUser, command), not (target, command):
// preserving this signature is what keeps every existing responder in the
// suite working unchanged after SSHClient moved to a SshTarget object.
export type FakeSSHResponder = (sshTarget: string, sshUser: string, command: string) => ExecResult;

export interface FakeStdinWrite {
  sshTarget: string;
  sshUser: string;
  command: string;
  text: string;
}

export interface FakeSSHCall {
  sshTarget: string;
  sshUser: string;
  command: string;
  interactive?: boolean;
  // Recorded only when the target actually carries them (see recordedTarget
  // below) -- never as explicit undefined keys.
  sshPort?: number;
  sshIdentityFile?: string;
}

export interface FakePutFileCall {
  sshTarget: string;
  sshUser: string;
  remotePath: string;
  content: Buffer;
}

// Flattens a SshTarget into the history shape tests assert on, omitting
// port/identityFile when unset. They must be omitted rather than set to
// undefined: several tests use assert.deepEqual (strict) against a literal
// { sshTarget, sshUser, command }, and a key holding undefined counts as a
// difference there.
function recordedTarget(target: SshTarget): Pick<FakeSSHCall, 'sshTarget' | 'sshUser' | 'sshPort' | 'sshIdentityFile'> {
  return {
    sshTarget: target.host,
    sshUser: target.user,
    ...(target.port === undefined ? {} : { sshPort: target.port }),
    ...(target.identityFile === undefined ? {} : { sshIdentityFile: target.identityFile }),
  };
}

export class FakeSSHClient implements SSHClient {
  private calls: FakeSSHCall[] = [];
  private putFileCalls: FakePutFileCall[] = [];
  private stdinWrites: FakeStdinWrite[] = [];

  constructor(private respond: FakeSSHResponder) {}

  async exec(
    target: SshTarget,
    command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult> {
    if (signal?.aborted) throw new Error('Job cancelled');
    this.calls.push({ ...recordedTarget(target), command });
    if (onStdinReady) {
      onStdinReady((text) =>
        this.stdinWrites.push({ sshTarget: target.host, sshUser: target.user, command, text })
      );
    }
    const result = this.respond(target.host, target.user, command);
    if (onChunk) {
      if (result.stdout) onChunk(result.stdout, 'stdout');
      if (result.stderr) onChunk(result.stderr, 'stderr');
    }
    return result;
  }

  // No pty/raw-mode simulation needed for logic-level tests -- delegates to
  // the same responder exec() uses, and marks the recorded call
  // interactive:true so tests can assert which exec path a command took.
  async execInteractive(target: SshTarget, command: string): Promise<ExecResult> {
    this.calls.push({ ...recordedTarget(target), command, interactive: true });
    return this.respond(target.host, target.user, command);
  }

  // Records the upload rather than the responder-driven round trip exec()
  // does -- an SFTP write has no remote output to respond with, so there's
  // nothing for a responder to return here.
  async putFile(target: SshTarget, remotePath: string, content: Buffer): Promise<void> {
    this.putFileCalls.push({ sshTarget: target.host, sshUser: target.user, remotePath, content });
  }

  get history(): FakeSSHCall[] {
    return this.calls;
  }

  get putFileHistory(): FakePutFileCall[] {
    return this.putFileCalls;
  }

  get stdinWriteHistory(): FakeStdinWrite[] {
    return this.stdinWrites;
  }
}

// A blanket "everything succeeds" responder for tests that don't care about
// install-app's `pct status <vmid>` collision pre-check (see issue #53) --
// reports the target vmid as free (nonzero exit) and every other command as
// a bare success, so tests exercising unrelated behavior don't each have to
// hand-roll their own pct-status branch.
export function defaultResponder(_sshTarget: string, _sshUser: string, command: string): ExecResult {
  if (command.startsWith('pct status ')) {
    return { stdout: '', stderr: '', code: 1 };
  }
  return { stdout: '', stderr: '', code: 0 };
}
