import type { SSHClient } from './ssh-client.ts';
import type { Inventory } from './inventory.ts';
import { runRemote } from './targets.ts';

// curl (no -k) against the backend's own port cleanly separates three
// cases: 60/51 = TLS present but the cert isn't trusted (the case this
// exists to detect -- 60 is "SSL certificate problem", 51 is "SSL peer
// certificate or SSH remote key was not OK", a related untrusted-cert
// signal some curl/TLS-backend combinations return instead of 60), 35 = no
// TLS at all on that port (a plain-HTTP backend -- the TLS handshake
// itself fails), 0 = TLS present and trusted (or a plain success). Every
// other exit code (7 connection-refused, 28 timeout, 6 DNS failure, ...)
// means "couldn't get a conclusive answer this attempt" -- worth a retry
// on the create path, never itself a final answer.
export type ProbeResult = 'insecure' | 'trusted' | 'inconclusive';

export function interpretCurlExitCode(code: number): ProbeResult {
  if (code === 60 || code === 51) return 'insecure';
  if (code === 0 || code === 35) return 'trusted';
  return 'inconclusive';
}

export interface ProbeOptions {
  retries?: number;
  intervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Probes the live app at https://<ip>:<port>/ from hostName (the guest's
// *parent host*, per issue #100 -- avoids depending on curl being
// installed inside the container itself) and interprets the result. Never
// throws: an SSH/exec failure is caught and treated as inconclusive, so
// every caller can treat the result as purely informational rather than an
// error path to handle -- but unlike a plain inconclusive curl exit code
// (host reached, app just isn't listening yet -- worth a retry), a thrown
// error means the SSH round-trip itself failed (host unreachable, or the
// job was cancelled -- Ssh2SSHClient.exec rejects with Error('Job
// cancelled') when its AbortSignal fires) and stops the retry loop
// immediately instead of burning the rest of the retry budget on a
// condition retries can't fix.
export async function probeInsecureBackendTls(
  ssh: SSHClient,
  inventory: Inventory,
  hostName: string,
  ip: string,
  port: number,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const retries = opts.retries ?? 0;
  const intervalMs = opts.intervalMs ?? 0;
  const sleep = opts.sleepFn ?? defaultSleep;
  const command = `curl -s -o /dev/null --max-time 5 https://${ip}:${port}/`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let execResult;
    try {
      execResult = await runRemote(ssh, inventory, hostName, command);
    } catch {
      return 'inconclusive';
    }
    const result = interpretCurlExitCode(execResult.code);
    // Each attempt logs a line so a job watching this probe's output (see
    // recordProvisionedGuest in src/web/routes/provisioning.ts) doesn't go
    // silent for up to ~3 minutes -- curl itself produces no stdout here.
    console.log(`TLS probe attempt ${attempt + 1}/${retries + 1} for https://${ip}:${port}/: ${result}`);
    if (result !== 'inconclusive') return result;
    if (attempt < retries) {
      try {
        await sleep(intervalMs);
      } catch {
        return 'inconclusive';
      }
    }
  }
  return 'inconclusive';
}
