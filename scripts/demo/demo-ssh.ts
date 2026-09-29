// A DemoSSHClient answers every command the web UI's real commands would
// send over SSH, entirely from the demo inventory in memory -- it never
// opens a socket. It lives here rather than reusing
// test/support/fake-ssh-client.ts so shipping/demo code never imports from
// test/ (Constitution II: Ssh2SSHClient is the only code that opens a real
// SSH connection; a fake that opens none is consistent with that, same as
// FakeSSHClient). See specs/014-web-ui-screenshots/research.md R2.
import type { ExecResult, SSHClient, SshTarget } from '../../src/lib/ssh-client.ts';
import type { GuestEntry, HostEntry, Inventory } from '../../src/lib/inventory.ts';
import { buildDemoInventory } from './demo-inventory.ts';

// Exported so the example-data guard (T004) can scan every canned output
// string this client ever produces.
export const DEMO_AUTHORIZED_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...(truncated placeholder key)...demo@example.com';
export const DEMO_PACKAGE_MANAGER = 'apt';

// A small, fixed subset of guests reported stopped, so the Dashboard's
// status column (and any screenshot of it) shows both states rather than
// an all-running fleet -- 'demo-vm' (the one VM) and 'grafana' (one lxc).
const DEMO_STOPPED_GUESTS = new Set<string>(['demo-vm', 'grafana']);

export function demoSimulatedOutput(command: string): string {
  const firstLine = command.split('\n')[0] ?? '';
  return `[demo] simulated: ${firstLine}`;
}

interface DemoResult {
  stdout: string;
  stderr: string;
  code: number;
}

function ok(stdout = ''): DemoResult {
  return { stdout, stderr: '', code: 0 };
}

function fail(stderr = '', code = 1): DemoResult {
  return { stdout: '', stderr, code };
}

export class DemoSSHClient implements SSHClient {
  private readonly inventory: Inventory;
  private readonly hostsByTarget = new Map<string, HostEntry>();

  constructor(inventory: Inventory = buildDemoInventory()) {
    this.inventory = inventory;
    for (const host of inventory.hosts) {
      this.hostsByTarget.set(host.ssh_target, host);
    }
  }

  private statusFor(guestName: string): 'running' | 'stopped' {
    return DEMO_STOPPED_GUESTS.has(guestName) ? 'stopped' : 'running';
  }

  private guestsOn(host: HostEntry, pveType: 'lxc' | 'qemu'): GuestEntry[] {
    const wantType = pveType === 'lxc' ? 'lxc' : 'vm';
    return this.inventory.guests.filter((g) => g.host === host.name && g.type === wantType);
  }

  // Answers a single, already-unwrapped command (the plain command sent
  // straight to a pve host, or the inner command a `pct exec`/`qm guest
  // exec` wrapper carries -- see execute() below for the qm envelope). Every
  // branch here mirrors research R2's list; the final catch-all keeps every
  // job in the demo completing instead of failing.
  private respond(target: SshTarget, command: string): DemoResult {
    const host = this.hostsByTarget.get(target.host);

    // Per-guest config (sync-inventory's IP extraction) -- checked before
    // the plain guest-listing match below, since
    // "/nodes/$(hostname)/lxc/<vmid>/config" would otherwise also match a
    // looser "/nodes/$(hostname)/lxc" pattern.
    const configMatch = command.match(/\/nodes\/\$\(hostname\)\/(lxc|qemu)\/(\d+)\/config\b/);
    if (configMatch && host) {
      const [, pveType, vmidStr] = configMatch;
      const vmid = Number(vmidStr);
      const guest = this.inventory.guests.find((g) => g.host === host.name && g.vmid === vmid);
      const ip = guest?.ip;
      const gateway = host.midScheme?.gateway ?? '';
      const config = !ip
        ? {}
        : pveType === 'lxc'
          ? { net0: `name=eth0,bridge=vmbr0,ip=${ip}/24,gw=${gateway}` }
          : { ipconfig0: `ip=${ip}/24,gw=${gateway}` };
      return ok(JSON.stringify(config));
    }

    // Guest listings (getGuestStatuses / sync-inventory's new-guest scan).
    const listMatch = command.match(/\/nodes\/\$\(hostname\)\/(lxc|qemu)\b/);
    if (listMatch && host) {
      const pveType = listMatch[1] as 'lxc' | 'qemu';
      const entries = this.guestsOn(host, pveType).map((g) => ({
        vmid: g.vmid,
        name: g.name,
        status: this.statusFor(g.name),
      }));
      return ok(JSON.stringify(entries));
    }

    // Network interfaces (bridges) -- keeps a Sync Inventory preview
    // reporting the example bridges back unchanged rather than emptying
    // them.
    if (/\/nodes\/\$\(hostname\)\/network\b/.test(command) && host) {
      const interfaces = (host.bridges ?? []).map((bridge) => ({
        iface: bridge.name,
        type: 'bridge',
        active: bridge.active ? 1 : 0,
        comments: bridge.alias,
      }));
      return ok(JSON.stringify(interfaces));
    }

    // Storage pools -- same "keep the demo inventory intact" goal as
    // network, above.
    if (/\/nodes\/\$\(hostname\)\/storage\b/.test(command) && host) {
      const storages = (host.storages ?? []).map((storage) => ({
        storage: storage.name,
        type: storage.type,
        content: storage.content.join(','),
        active: storage.active ? 1 : 0,
        enabled: storage.active ? 1 : 0,
      }));
      return ok(JSON.stringify(storages));
    }

    // install-app/create-lxc/migrate-guest's VMID-availability pre-check
    // (checkVmidAvailable, src/lib/targets.ts): exits non-zero, meaning
    // "not found" for both pct and qm, i.e. free.
    if (/^pct status \d+/.test(command)) {
      return fail('', 1);
    }

    // readHostAuthorizedKeys.
    if (command.includes('cat ~/.ssh/authorized_keys')) {
      return ok(`${DEMO_AUTHORIZED_KEY}\n`);
    }

    // The package-manager probe (PROBE_COMMAND, src/lib/package-manager.ts)
    // tests `command -v apt-get` first -- matching on that alone is enough
    // to recognize the whole if/elif chain.
    if (command.includes('command -v apt-get')) {
      return ok(`${DEMO_PACKAGE_MANAGER}\n`);
    }

    // Catch-all: a plausible success for anything else this toolkit might
    // ever send, so every demo job completes rather than failing over a
    // command this fake doesn't specifically know about.
    return ok(demoSimulatedOutput(command));
  }

  // Resolves what respond() above should actually be handed, and how its
  // result should be shaped on the way back out -- a `qm guest exec`
  // wrapper (runRemote's 'vm' branch, src/lib/targets.ts) expects its own
  // JSON envelope on stdout with the real exit code inside, not a plain
  // ExecResult; a `pct exec ... sh -c '...'` wrapper and a bare host
  // command both pass the inner result straight through unchanged.
  private execute(target: SshTarget, command: string): DemoResult {
    if (/^qm guest exec \d+ --timeout \d+ -- sh -c /.test(command)) {
      const inner = this.respond(target, command);
      return ok(JSON.stringify({ exitcode: inner.code, 'out-data': inner.stdout, 'err-data': inner.stderr }));
    }
    return this.respond(target, command);
  }

  async exec(
    target: SshTarget,
    command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult> {
    if (signal?.aborted) throw new Error('Job cancelled');
    // Nothing in the demo ever needs to write back to a watched exec's
    // stdin, but every real SSHClient.exec() caller that supplies this is
    // entitled to a writer, same as FakeSSHClient.
    if (onStdinReady) onStdinReady(() => {});
    const result = this.execute(target, command);
    if (onChunk) {
      if (result.stdout) onChunk(result.stdout, 'stdout');
      if (result.stderr) onChunk(result.stderr, 'stderr');
    }
    return result;
  }

  // The CLI-only interactive path (install-app's real-pty mode) is never
  // reached from the demo web UI, but the interface requires it -- answered
  // the same deterministic way as a plain exec().
  async execInteractive(target: SshTarget, command: string): Promise<ExecResult> {
    return this.execute(target, command);
  }

  // Nothing the demo does needs an actual file transfer (deploy-vpn-gateway
  // is the only caller, and it is never exercised from the demo's read-only
  // and preview-only surface). Full parameter list kept (rather than an
  // empty one) so a caller matching SSHClient's real putFile() signature
  // still typechecks against this implementation.
  async putFile(_target: SshTarget, _remotePath: string, _content: Buffer): Promise<void> {}
}
