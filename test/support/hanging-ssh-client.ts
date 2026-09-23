import type { ExecResult, SSHClient, SshTarget } from '../../src/lib/ssh-client.ts';

// A test-only SSHClient whose exec() genuinely stays pending until the test
// calls finish() -- unlike FakeSSHClient (which resolves synchronously),
// this is needed to test JobRunner's awaiting_input orchestration, where
// the job's status must actually observe 'awaiting_input' before it can
// observe 'success'. Simulates a real Ssh2SSHClient exec() call that's
// genuinely blocked on a remote `read` with stdin kept open (see issue #57).
export class HangingSSHClient implements SSHClient {
  writes: string[] = [];
  private resolveExec: ((result: ExecResult) => void) | undefined;

  exec(
    _target: SshTarget,
    _command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult> {
    onStdinReady?.((text) => this.writes.push(text));
    onChunk?.('Add Adminer? (y/N) ', 'stdout');
    return new Promise((resolve, reject) => {
      this.resolveExec = resolve;
      // Mirrors Ssh2SSHClient.exec()'s real abort behavior (src/lib/ssh-client.ts):
      // ending the connection while a remote command is genuinely hung on a
      // prompt rejects rather than resolves, so a cancelled job is never
      // mistaken for one that completed. Without this, JobRunner's 15-minute
      // abandon-timer cancel() would have nothing to actually settle this
      // promise -- it would hang forever instead of ever reaching 'cancelled'.
      signal?.addEventListener('abort', () => reject(new Error('Job cancelled')));
    });
  }

  finish(result: ExecResult): void {
    this.resolveExec?.(result);
  }

  execInteractive(): Promise<ExecResult> {
    return Promise.reject(new Error('not used in this fixture'));
  }

  putFile(): Promise<void> {
    return Promise.resolve();
  }
}
