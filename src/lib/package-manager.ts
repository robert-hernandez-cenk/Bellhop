import type { Inventory } from './inventory.ts';
import type { ExecResult, SSHClient } from './ssh-client.ts';
import { runRemote } from './targets.ts';

// The package managers `update-all` knows how to drive. `yum` is
// deliberately absent -- a yum-only RHEL 7-era guest reports `unknown`
// rather than being silently handled by a compatibility shim.
export type PackageManager = 'apt' | 'dnf' | 'apk' | 'pacman' | 'zypper';

const PACKAGE_MANAGERS: readonly PackageManager[] = ['apt', 'dnf', 'apk', 'pacman', 'zypper'];

// Probed at runtime rather than read from inventory. Proxmox does store an
// `ostype` on every LXC (and sync-inventory already fetches the config JSON
// that carries it), but that value is a label set at container creation --
// it can be `unmanaged`, mislabeled, or stale after an in-place distro
// change, and it is a useless generic `l26` for every Linux VM. `command -v`
// is ground truth, and it is POSIX: it works under busybox ash, which is all
// a default Alpine container has.
//
// apt-get is tested first so Debian/Ubuntu -- every guest currently in this
// homelab -- short-circuits on the first test.
export const PROBE_COMMAND = [
  'if command -v apt-get >/dev/null 2>&1; then echo apt',
  'elif command -v dnf >/dev/null 2>&1; then echo dnf',
  'elif command -v apk >/dev/null 2>&1; then echo apk',
  'elif command -v pacman >/dev/null 2>&1; then echo pacman',
  'elif command -v zypper >/dev/null 2>&1; then echo zypper',
  'else echo unknown; fi',
].join('\n');

// Every entry must be fully non-interactive -- these run over a
// non-interactive exec channel whose stdin is closed, so any prompt is a
// hang or an immediate EOF failure rather than a question anyone can answer.
// `pacman -Syu` is a full system upgrade because Arch supports no partial
// upgrade path; that is Arch's model, not a choice made here.
export const UPDATE_COMMANDS: Record<PackageManager, string> = {
  apt: 'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade',
  dnf: 'dnf -y --refresh upgrade',
  apk: 'apk update && apk upgrade',
  pacman: 'pacman -Syu --noconfirm',
  // --gpg-auto-import-keys on the refresh because --non-interactive alone
  // auto-*declines* an unknown repo signing key rather than prompting, so a
  // first refresh after a repo is added would fail outright.
  zypper: 'zypper --non-interactive --gpg-auto-import-keys refresh && zypper --non-interactive update',
};

// Takes the last non-empty line so a login-shell motd or banner ahead of the
// probe's own output cannot corrupt the result. Returns undefined for
// `unknown` and for anything unrecognized -- the caller treats both the same
// way, since neither yields a command we can run.
export function parsePackageManager(stdout: string): PackageManager | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return PACKAGE_MANAGERS.find((pm) => pm === last);
}

// Shared, human-readable tried-list -- both update-all's unknown-OS warning
// and UnknownPackageManagerError's message quote this exact string, so the
// two can never drift apart.
export const PROBED_COMMANDS = 'apt-get, dnf, apk, pacman, zypper';

// The probe-then-classify sequence `update-all` and `configure-guest` both
// need before they can do anything target-specific -- what differs between
// them is the *reaction* to each outcome (a result bucket vs. a thrown
// error), which is left to the caller. A connection-level failure is not a
// variant here: runRemote throws, and it propagates to the caller uncaught,
// exactly as it does today.
export type DetectionResult =
  | { kind: 'detected'; pm: PackageManager }
  | { kind: 'unknown' }
  | { kind: 'probe-failed'; result: ExecResult };

export async function detectPackageManager(
  ssh: SSHClient,
  inv: Inventory,
  target: string
): Promise<DetectionResult> {
  const result = await runRemote(ssh, inv, target, PROBE_COMMAND);
  if (result.code !== 0) {
    return { kind: 'probe-failed', result };
  }
  const pm = parsePackageManager(result.stdout);
  if (!pm) {
    return { kind: 'unknown' };
  }
  return { kind: 'detected', pm };
}

// Thrown by configure-guest (a single-target command) for the `unknown`
// variant, so any caller -- web, MCP, tests -- can tell this case apart from
// a generic failure with `instanceof`. update-all instead buckets `unknown`
// into failUnknownPm and keeps going, since it runs across many targets.
export class UnknownPackageManagerError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(
      `No known package manager on ${target} (tried ${PROBED_COMMANDS}); install the packages on ${target} by hand`
    );
    this.name = 'UnknownPackageManagerError';
    this.target = target;
  }
}
