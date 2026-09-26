import type { Inventory, HostEntry, GuestEntry } from './inventory.ts';
import type { SSHClient, ExecResult, SshTarget } from './ssh-client.ts';
import { shellQuote } from './ssh-client.ts';

// `qm guest exec --timeout <N>`'s own N -- named so runRemote's command
// string and its timeout-envelope failure message (see the `vm` branch of
// runRemote below) can never drift apart.
const VM_EXEC_TIMEOUT_SECONDS = 60;

// `qm guest exec`'s JSON output embeds a completed command's own stdout/
// stderr as a raw substring inside its "out-data"/"err-data" string values,
// without escaping any control character (newline, CR, tab) the command
// itself printed -- verified live 2026-09-26: the captured "completed with
// non-zero exit" envelope (`sh -c 'echo ok; exit 3'`) carries a literal,
// unescaped newline between `"ok` and the closing `"` of `"out-data"`,
// which is not strict JSON -- `JSON.parse` throws "Bad control character in
// string literal" on it outright, even though the command actually
// succeeded in producing that output. Since virtually every real command's
// output ends in a newline (`echo` alone always adds one), parsing this
// envelope with a bare `JSON.parse` would misreport most completed guest
// commands as unparseable. This walks the raw text once, tracking whether
// it is inside a JSON string literal (respecting `\"` escapes), and
// re-escapes any literal control character found there before handing the
// result to `JSON.parse` -- a no-op on already-strict JSON (e.g. anything
// built with `JSON.stringify`), and still lets genuinely malformed output
// fail to parse.
function sanitizeGuestExecEnvelope(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

export type ResolvedTarget =
  | { kind: 'pve'; host: HostEntry }
  | { kind: 'lxc' | 'vm'; guest: GuestEntry; parentHost: HostEntry };

export function resolveTarget(inv: Inventory, name: string): ResolvedTarget {
  const host = inv.hosts.find((h) => h.name === name);
  if (host) {
    return { kind: 'pve', host };
  }
  const guest = inv.guests.find((g) => g.name === name);
  if (guest) {
    const parentHost = inv.hosts.find((h) => h.name === guest.host);
    if (!parentHost) {
      throw new Error(
        `Inventory entry '${name}' has host '${guest.host}' which does not match any entry in hosts[]`
      );
    }
    return { kind: guest.type, guest, parentHost };
  }
  throw new Error(`Unknown inventory entry: ${name}`);
}

// The single mapping point from an inventory entry to SSH connection
// parameters. Every call site that opens a connection goes through this, so
// a new per-host connection setting only ever has to be threaded here.
export function hostSshTarget(host: HostEntry): SshTarget {
  return {
    host: host.ssh_target,
    user: host.ssh_user,
    port: host.ssh_port,
    identityFile: host.ssh_identity_file,
  };
}

export async function runRemote(
  ssh: SSHClient,
  inv: Inventory,
  name: string,
  command: string
): Promise<ExecResult> {
  const target = resolveTarget(inv, name);
  switch (target.kind) {
    case 'pve':
      return ssh.exec(hostSshTarget(target.host), command);
    case 'lxc': {
      // `sh`, not `bash`: a default Alpine container has only busybox ash at
      // /bin/sh, so a bash wrapper would fail before the command ever ran.
      // Every command routed through runRemote must therefore be POSIX sh.
      const remoteCmd = `pct exec ${target.guest.vmid} -- sh -c ${shellQuote(command)}`;
      return ssh.exec(hostSshTarget(target.parentHost), remoteCmd);
    }
    case 'vm': {
      const remoteCmd = `qm guest exec ${target.guest.vmid} --timeout ${VM_EXEC_TIMEOUT_SECONDS} -- sh -c ${shellQuote(command)}`;
      const result = await ssh.exec(hostSshTarget(target.parentHost), remoteCmd);
      if (result.code !== 0) {
        // ssh/qm itself failed (e.g. connection failure) -- no JSON to parse.
        return result;
      }
      let parsed: { pid?: number; exitcode?: number; 'out-data'?: string; 'err-data'?: string };
      try {
        parsed = JSON.parse(sanitizeGuestExecEnvelope(result.stdout));
      } catch {
        return {
          stdout: '',
          stderr: `qm guest exec output could not be parsed as JSON: ${result.stdout.trim()}`,
          code: 1,
        };
      }
      if (typeof parsed.exitcode !== 'number') {
        // `--timeout <N>` elapsed before the command finished: `qm guest
        // exec` returns a pid-only envelope with no `exitcode` at all, and
        // the command is still running in the guest -- this is a failure,
        // not the success the old `parsed.exitcode ?? 0` silently reported.
        const pidNote = typeof parsed.pid === 'number' ? ` (pid ${parsed.pid})` : '';
        return {
          stdout: '',
          stderr: `qm guest exec timed out after ${VM_EXEC_TIMEOUT_SECONDS}s; the command is still running in the guest${pidNote}`,
          code: 1,
        };
      }
      return {
        stdout: parsed['out-data'] ?? '',
        stderr: parsed['err-data'] ?? '',
        code: parsed.exitcode,
      };
    }
  }
}

export type TargetSelector = { host: string } | { all: true } | { group: 'pve' | 'lxc' | 'vm' };

export function selectTargets(inv: Inventory, selector: TargetSelector): string[] {
  if ('host' in selector) {
    const exists =
      inv.hosts.some((h) => h.name === selector.host) || inv.guests.some((g) => g.name === selector.host);
    if (!exists) {
      throw new Error(`Unknown host/guest: ${selector.host}`);
    }
    return [selector.host];
  }
  if ('all' in selector) {
    return [...inv.hosts.map((h) => h.name), ...inv.guests.map((g) => g.name)];
  }
  if (selector.group === 'pve') {
    return inv.hosts.map((h) => h.name);
  }
  return inv.guests.filter((g) => g.type === selector.group).map((g) => g.name);
}

export interface ResolvedMid {
  vmid: number;
  ip: string;
  gateway: string;
}

export function resolveMid(inv: Inventory, hostName: string, mid: number): ResolvedMid {
  if (!Number.isInteger(mid) || mid < 1 || mid > 254) {
    throw new Error(`Invalid --mid: ${mid} (must be a number from 1 to 254)`);
  }
  const host = inv.hosts.find((h) => h.name === hostName);
  if (!host) {
    throw new Error(`Unknown host: ${hostName}`);
  }
  const scheme = host.midScheme;
  if (!scheme) {
    throw new Error(
      `Host '${hostName}' has no midScheme configured (set inventory.hosts[].midScheme to use --mid)`
    );
  }
  return {
    vmid: scheme.vmidBase + mid,
    ip: `${scheme.ipPrefix}${mid}/${scheme.cidrSuffix ?? 16}`,
    gateway: scheme.gateway,
  };
}

// mid.ip carries a /16 mask (e.g. "192.168.1.4/16") for use in --net0/
// --ipconfig0; inventory stores bare IPs, and an operator-facing "ssh
// root@<ip>" line needs one too, so callers strip it before writing to
// inventory or displaying it.
export function stripCidr(ip: string): string {
  return ip.split('/')[0];
}

// VMIDs are one namespace shared across lxc and vm guests (resolveMid
// above derives the same vmid regardless of which command asked), so a
// colliding vmid might already be occupied by either kind -- pct status
// alone would report a same-numbered vm guest as free. `A || B` exits 0
// (in use) if either command finds the vmid, and nonzero (free) only when
// both report "not found". Shared by install-app (which needs this
// because community-scripts' build.func silently reassigns the VMID on a
// collision instead of failing loudly -- see issue #53) and migrate-guest
// (which needs the target host's derived VMID to genuinely be free before
// restoring a backup onto it).
export async function checkVmidAvailable(ssh: SSHClient, inv: Inventory, hostName: string, vmid: number): Promise<void> {
  const result = await runRemote(ssh, inv, hostName, `pct status ${vmid} >/dev/null 2>&1 || qm status ${vmid} >/dev/null 2>&1`);
  if (result.code !== 0) {
    return;
  }
  const existing = inv.guests.find((g) => g.host === hostName && g.vmid === vmid);
  throw new Error(
    `VMID ${vmid} on '${hostName}' is already in use${existing ? ` by '${existing.name}'` : ''} -- choose a different --mid`
  );
}
