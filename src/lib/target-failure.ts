import type { ExecResult } from './ssh-client.ts';

// One target that failed during a fleet-wide command, with the reason. Fleet
// commands isolate failures per target so one bad host never fails the whole
// run -- this keeps that isolation without discarding *why* it failed
// (issue #141: an unreadable ssh_identity_file, a refused auth, and a host
// that's simply down used to all surface as the same bare target name).
export interface TargetFailure {
  target: string;
  error: string;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// For a command that ran but exited nonzero, so the caught error says what
// went wrong rather than only "exit code 255".
export function exitCodeError(result: ExecResult): Error {
  const stderr = result.stderr.trim();
  return new Error(`exit code ${result.code}${stderr ? `: ${stderr}` : ''}`);
}

// Single-line form, for a web job's failure message.
export function formatFailureList(failures: TargetFailure[]): string {
  return failures.map((f) => `${f.target} (${f.error})`).join(', ') || 'none';
}

// Multi-line form, for a CLI "Summary:" block.
export function formatFailureLines(label: string, failures: TargetFailure[]): string[] {
  if (failures.length === 0) return [`  ${label}: none`];
  return [`  ${label}:`, ...failures.map((f) => `    ${f.target}: ${f.error}`)];
}
