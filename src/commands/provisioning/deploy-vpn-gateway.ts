import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory, GuestEntry } from '../../lib/inventory.ts';
import { saveInventory, refreshInventory } from '../../lib/inventory.ts';
import { runRemote, resolveMid, stripCidr, hostSshTarget, type ResolvedMid } from '../../lib/targets.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { pickStorage } from '../../lib/storage.ts';
import { readHostAuthorizedKeys, buildAuthorizedKeysWriteScript } from '../../lib/authorized-keys.ts';
import { logInfo, logWarn } from '../../lib/log.ts';
import { LocalGoBuilder, type GoBuilder } from '../../lib/go-build.ts';
import { resolveNordVpnPreviewServer } from '../../lib/nordvpn-preview.ts';
import { resolvePiaPreviewServer } from '../../lib/pia-preview.ts';

// This file lives at src/commands/provisioning/deploy-vpn-gateway.ts, so
// three levels up is the repo root -- mirrors cli.ts's own REPO_ROOT
// computation, kept local here rather than importing from cli.ts to avoid
// a commands -> cli.ts layering inversion.
const AGENT_SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vpn-gateway-agent');

type VpnPreviewServer = { hostname: string; country: string };

// pct create's <ostemplate> argument needs a full volid
// (storage:vztmpl/<filename>), which varies by exact point release and
// which storage caches it -- unlike create-lxc, deploy-vpn-gateway's own
// flags don't include --template, so this is a fixed default. Confirmed
// live via `pveam list local` on pve-node-a
// (2026-08-03), after aligning all three template caches (pve-node-a
// local, pve-node-b local, nas-proxmox shared storage) to the
// Proxmox mirror's then-current debian-13-standard release -- re-check
// the same way if this host's cached template ever moves to a newer
// point release.
const GATEWAY_LXC_TEMPLATE = 'local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst';

const SYSTEMD_UNIT = [
  '[Unit]',
  'Description=VPN Gateway Agent',
  'After=network-online.target',
  'Wants=network-online.target',
  '',
  '[Service]',
  'EnvironmentFile=/etc/vpn-gateway/credentials.env',
  'ExecStart=/usr/local/bin/vpn-gateway-agent',
  'Restart=on-failure',
  'RestartSec=5',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
].join('\n');

// Not enforced in code (this is a single-operator homelab tool -- see
// CLAUDE.md's "Project philosophy"), but the operator should pass --mid 15
// for a nordvpn gateway and --mid 16 for a pia gateway (both free on
// pve-node-a at the time this was written) -- --mid stays a required,
// un-hardcoded flag the same way every other MID-deriving command's is.
export interface DeployVpnGatewayOptions {
  host: string;
  mid: number;
  // The gateway guest's name -- required, with no derived default (same
  // shape as create-lxc.ts's own required `hostname` option), so multiple
  // gateways for the same provider can coexist (e.g. 'nordvpn-us-gw-lxc'
  // and 'nordvpn-eu-gw-lxc').
  name: string;
  vpn: 'nordvpn' | 'pia';
  apply?: boolean;
  // Operator-chosen rootfs storage (the web UI's Storage dropdown); falls
  // back to pickStorage's automatic selection when omitted, so the CLI
  // (which has no --storage flag) keeps working unchanged. Same pattern as
  // create-lxc.ts's own `storage` option.
  storage?: string;
  // Operator-supplied credentials (the web UI's conditional per-provider
  // fields); override the process.env reads below when present, falling
  // back to them when omitted -- same override pattern as `storage`. No
  // CLI flags exist for these; the CLI keeps sourcing them from
  // process.env only.
  accessToken?: string;
  piaUsername?: string;
  piaPassword?: string;
  // Internal test-speed knobs for the post-provision connectivity poll --
  // deliberately not exposed as CLI flags; the defaults (20 attempts, 3s
  // apart = ~60s) are what a real deploy always uses -- generous enough to
  // cover container boot + NordVPN auth + wg-quick up on a first deploy.
  connectPollAttempts?: number;
  connectPollDelayMs?: number;
}

export function buildCreateGatewayLxcCommand(mid: ResolvedMid, hostname: string, storage: string, bridge = 'vmbr0'): string {
  return (
    `pct create ${mid.vmid} ${shellQuote(GATEWAY_LXC_TEMPLATE)} ` +
    `--hostname ${shellQuote(hostname)} --cores 1 --memory 512 ` +
    `--rootfs ${shellQuote(storage)}:8 --unprivileged 0 ` +
    `--net0 name=eth0,bridge=${shellQuote(bridge)},ip=${shellQuote(mid.ip)},gw=${shellQuote(mid.gateway)} ` +
    `--start 1 && ` +
    // openresolv: wg-quick's set_dns step (triggered by wg0.conf's DNS =
    // line) shells out to resolvconf/openresolv -- Debian's wireguard-tools
    // package only Suggests it, not Recommends, so apt won't pull it in on
    // its own and wg-quick up would otherwise fail outright.
    `pct exec ${mid.vmid} -- bash -c ${shellQuote('apt-get update && apt-get install -y wireguard-tools iptables openresolv')}`
  );
}

// Builds /etc/vpn-gateway/credentials.env's content for either provider --
// VPN_PROVIDER is always present so main.go's selectProvider can pick the
// right client without inferring it from which credential vars happen to
// be set (see this plan's Global Constraints).
type CredentialsEnvOpts =
  | { vpn: 'nordvpn'; accessToken: string; gatewayLanIp: string }
  | { vpn: 'pia'; piaUsername: string; piaPassword: string; gatewayLanIp: string };

// GATEWAY_LAN_IP feeds netctl.Manager.Apply's LAN-bypass ip rule (see
// vpn-gateway-agent/netctl/netctl.go): without it, the agent's own calls to
// the VPN provider's API ride its own tunnel and fail whenever the current
// exit node has a bad path to the provider.
export function buildCredentialsEnv(opts: CredentialsEnvOpts): string {
  if (opts.vpn === 'nordvpn') {
    return [`NORDVPN_ACCESS_TOKEN=${opts.accessToken}`, `VPN_PROVIDER=nordvpn`, `GATEWAY_LAN_IP=${opts.gatewayLanIp}`].join('\n');
  }
  // systemd's EnvironmentFile= parser does its own quote-grouping/backslash
  // unescaping, independent of the heredoc quoting buildGatewayProvisionScript
  // wraps this content in -- a newline in either value would inject an extra
  // line into the env file regardless of any escaping, so that's rejected
  // outright. `"`/`'`/`\`/`#` are all valid characters in a real PIA account
  // password and are deliberately NOT rejected here; whether systemd's parser
  // treats them fully literally in every case is a known, narrower residual
  // risk, not yet confirmed against a real account -- same spirit as this
  // codebase's other "VERIFY LIVE" comments for behavior not yet confirmed
  // against real-world input.
  if (opts.piaUsername.includes('\n') || opts.piaPassword.includes('\n')) {
    throw new Error('PIA_USERNAME/PIA_PASSWORD must not contain newlines');
  }
  return [`PIA_USERNAME=${opts.piaUsername}`, `PIA_PASSWORD=${opts.piaPassword}`, `VPN_PROVIDER=pia`, `GATEWAY_LAN_IP=${opts.gatewayLanIp}`].join(
    '\n'
  );
}

// Everything after pct create runs as ONE runRemote call (rather than
// several separate round-trips) since the gateway guest isn't in inventory
// yet at this point -- runRemote's by-name resolution (used everywhere else
// in this toolkit) needs an inventory entry to resolve a target from, so
// the two steps that write files *inside* the container manually build their
// own `pct exec <vmid> -- bash -c '...'` wrapper, for the same reason
// buildAuthorizedKeysWriteScript needs one. It stays bash here deliberately,
// unlike the `sh -c` that function and runRemote both switched to in issue
// #120, since this command builds its own Debian container and apt-get
// installs into it -- there is no bash-less guest to accommodate. The whole
// script is sent via runRemote targeting the HOST.
//
// The agent binary is NOT embedded here: it's ~9-10MB, and base64-encoding
// it into a single `bash -c '...'` argument (the original approach) blew
// straight past Linux's MAX_ARG_STRLEN, which caps one exec argv element at
// 131,072 bytes -- the command failed with E2BIG before anything ran. It is
// instead SFTP'd to remoteBinaryPath on the HOST filesystem by the caller
// (SSHClient.putFile; SFTP reaches the host's sshd, and there is no direct
// SSH path into an LXC container) and moved into the guest here by
// Proxmox's own `pct push`, which never puts the bytes in a command string
// at all. Everything this script does send is small: a token line and a
// ~15-line systemd unit.
export function buildGatewayProvisionScript(vmid: number, credentialsEnvContent: string, remoteBinaryPath: string): string {
  const credentialsDelim = 'VPN_GATEWAY_CREDENTIALS_EOF';
  const unitDelim = 'VPN_GATEWAY_UNIT_EOF';
  const writeCredentials = [
    'mkdir -p /etc/vpn-gateway',
    `cat > /etc/vpn-gateway/credentials.env <<'${credentialsDelim}'`,
    credentialsEnvContent,
    credentialsDelim,
    'chmod 600 /etc/vpn-gateway/credentials.env',
  ].join('\n');
  const writeUnit = [
    `cat > /etc/systemd/system/vpn-gateway-agent.service <<'${unitDelim}'`,
    SYSTEMD_UNIT,
    unitDelim,
  ].join('\n');
  // pct push / rm run directly on the host (no pct exec wrapper -- they're
  // host-side commands, same as pct create/pct set elsewhere in this
  // codebase); the two (deliberately bash, see above) bash -c calls need the
  // wrapper since they write files inside the container.
  return [
    'set -e',
    `pct exec ${vmid} -- bash -c ${shellQuote(writeCredentials)}`,
    `pct push ${vmid} ${shellQuote(remoteBinaryPath)} /usr/local/bin/vpn-gateway-agent --perms 0755`,
    `rm -f ${shellQuote(remoteBinaryPath)}`,
    `pct exec ${vmid} -- bash -c ${shellQuote(writeUnit)}`,
    `pct exec ${vmid} -- systemctl daemon-reload`,
    `pct exec ${vmid} -- systemctl enable --now vpn-gateway-agent`,
  ].join('\n');
}

// systemctl enable --now returns exit 0 as soon as the unit's process is
// forked -- long before the agent has authenticated with NordVPN, brought
// the tunnel up, or (on a bad token) hit its own log.Fatal. Writing
// `vpnGateway: 'nordvpn'` into inventory off that exit code alone would be
// exactly the phantom-success failure class CLAUDE.md documents from the
// install-app incident, so the deploy only counts as successful once the
// agent's own /status endpoint says it's connected.
async function waitForGatewayConnected(
  gatewayIp: string,
  fetchImpl: typeof fetch,
  attempts: number,
  delayMs: number
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`http://${gatewayIp}:8080/status`);
      if (response.ok) {
        const body = (await response.json()) as { connected?: boolean };
        if (body.connected) return;
      }
    } catch {
      // agent not listening yet -- keep trying
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `${gatewayIp}:8080/status never reported connected after ${attempts} attempt(s) -- the guest was created but vpn-gateway-agent may not be running correctly; check its systemd status/logs (systemctl status vpn-gateway-agent, journalctl -u vpn-gateway-agent) before retrying`
  );
}

export async function runDeployVpnGateway(
  opts: DeployVpnGatewayOptions,
  deps: { ssh: SSHClient; inventory: Inventory; inventoryPath: string; goBuilder?: GoBuilder; fetchImpl?: typeof fetch }
): Promise<{ createCommand: string; mid: ResolvedMid; previewServer: VpnPreviewServer; applied: boolean }> {
  let buildEnv: (gatewayLanIp: string) => string;
  let resolvePreview: () => Promise<VpnPreviewServer>;
  if (opts.vpn === 'nordvpn') {
    const accessToken = opts.accessToken || process.env.NORDVPN_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error(
        'NordVPN access token is not set -- fill in the Access Token field on the Deploy VPN Gateway form, or set NORDVPN_ACCESS_TOKEN for CLI use'
      );
    }
    buildEnv = (gatewayLanIp) => buildCredentialsEnv({ vpn: 'nordvpn', accessToken, gatewayLanIp });
    resolvePreview = () => resolveNordVpnPreviewServer(accessToken, deps.fetchImpl);
  } else if (opts.vpn === 'pia') {
    const piaUsername = opts.piaUsername || process.env.PIA_USERNAME;
    const piaPassword = opts.piaPassword || process.env.PIA_PASSWORD;
    if (!piaUsername || !piaPassword) {
      throw new Error(
        'PIA username/password are not set -- fill in the Username/Password fields on the Deploy VPN Gateway form, or set PIA_USERNAME/PIA_PASSWORD for CLI use'
      );
    }
    buildEnv = (gatewayLanIp) => buildCredentialsEnv({ vpn: 'pia', piaUsername, piaPassword, gatewayLanIp });
    resolvePreview = () => resolvePiaPreviewServer(piaUsername, piaPassword, deps.fetchImpl);
  } else {
    // opts.vpn is typed 'nordvpn' | 'pia', but nothing actually validates
    // the CLI's --vpn flag at runtime (Commander's `<nordvpn|pia>` in
    // requiredOption is only a --help placeholder, not a validator) -- a
    // typo like `--vpn Pia` would otherwise silently fall through to the
    // PIA branch above via `!== 'nordvpn'`, create a real LXC, and write an
    // invalid `vpnGateway` value into inventory. Fail loudly instead.
    throw new Error(`--vpn must be 'nordvpn' or 'pia', got '${opts.vpn}'`);
  }

  const host = deps.inventory.hosts.find((h) => h.name === opts.host);
  if (!host) {
    throw new Error(`Not a Proxmox host in inventory: ${opts.host}`);
  }

  // saveInventory (via validateInventory) already rejects two guests
  // sharing the same name, but only at write time -- after pct create, the
  // agent cross-compile/upload, provisioning, and the ~60s connectivity poll
  // have all already run. Catch it here instead, before confirmOrDryRun, so
  // a name collision fails at preview time (cheap) rather than leaving a
  // fully-provisioned, unrecorded container behind. Unlike the old
  // duplicate-provider guard this replaces, provider reuse is fine now --
  // it's name reuse that's the natural new mistake this branch's
  // multi-gateway-per-provider support opens up.
  const existingGuest = deps.inventory.guests.find((g) => g.name === opts.name);
  if (existingGuest) {
    throw new Error(
      `A guest named '${opts.name}' already exists in inventory (vmid ${existingGuest.vmid} on '${existingGuest.host}') -- choose a different --name.`
    );
  }

  const mid = resolveMid(deps.inventory, opts.host, opts.mid);
  const credentialsEnv = buildEnv(stripCidr(mid.ip));
  const storage = opts.storage || pickStorage(host, ['rootdir', 'images']);
  const hostname = opts.name;
  const createCommand = buildCreateGatewayLxcCommand(mid, hostname, storage);

  // Resolved in both dry-run and apply -- so the preview is provably
  // identical to what apply sends, same bar create-lxc/install-app hold to.
  const hostKeys = await readHostAuthorizedKeys(deps.ssh, deps.inventory, opts.host);
  const previewServer = await resolvePreview();

  const applied = confirmOrDryRun(
    `Would run on ${opts.host}: ${createCommand}\n(then push vpn-gateway-agent, connect to ${previewServer.hostname} in ${previewServer.country} on first start)`,
    opts.apply ?? false
  );
  if (!applied) {
    return { createCommand, mid, previewServer, applied: false };
  }

  logInfo(`Creating ${hostname} (vmid ${mid.vmid}) on ${opts.host}...`);
  const createResult = await runRemote(deps.ssh, deps.inventory, opts.host, createCommand);
  if (createResult.code !== 0) {
    throw new Error(`pct create failed on ${opts.host} (exit ${createResult.code}): ${createResult.stderr || createResult.stdout}`);
  }

  if (hostKeys) {
    const keysResult = await runRemote(deps.ssh, deps.inventory, opts.host, buildAuthorizedKeysWriteScript(mid.vmid, hostKeys));
    if (keysResult.code !== 0) {
      logWarn(`${hostname} created successfully (vmid ${mid.vmid}), but provisioning SSH keys failed: ${keysResult.stderr || keysResult.stdout}`);
    }
  } else {
    logWarn(`No authorized_keys found on host '${opts.host}'; skipping SSH key provisioning for ${hostname}`);
  }

  logInfo('Cross-compiling vpn-gateway-agent (GOOS=linux GOARCH=amd64)...');
  const goBuilder = deps.goBuilder ?? new LocalGoBuilder();
  const binary = await goBuilder.build(AGENT_SOURCE_DIR);

  // SFTP the binary onto the HOST first; the provisioning script below then
  // pct-pushes it into the guest. See buildGatewayProvisionScript's comment
  // for why the bytes can never travel inside a command string.
  const remoteBinaryPath = `/tmp/vpn-gateway-agent-${mid.vmid}.bin`;
  logInfo(`Uploading vpn-gateway-agent (${binary.length} bytes) to ${opts.host}:${remoteBinaryPath}...`);
  await deps.ssh.putFile(hostSshTarget(host), remoteBinaryPath, binary);

  logInfo(`Pushing vpn-gateway-agent into ${hostname} and starting its service...`);
  const provisionResult = await runRemote(
    deps.ssh,
    deps.inventory,
    opts.host,
    buildGatewayProvisionScript(mid.vmid, credentialsEnv, remoteBinaryPath)
  );
  if (provisionResult.code !== 0) {
    throw new Error(
      `${hostname} was created (vmid ${mid.vmid}), but installing/starting vpn-gateway-agent failed: ${provisionResult.stderr || provisionResult.stdout} -- the guest was not rolled back.`
    );
  }

  logInfo(`Waiting for vpn-gateway-agent on ${stripCidr(mid.ip)} to connect...`);
  await waitForGatewayConnected(
    stripCidr(mid.ip),
    deps.fetchImpl ?? fetch,
    opts.connectPollAttempts ?? 20,
    opts.connectPollDelayMs ?? 3000
  );

  const newGuest: GuestEntry = {
    name: hostname,
    type: 'lxc',
    vmid: mid.vmid,
    host: opts.host,
    ip: stripCidr(mid.ip),
    vpnGateway: opts.vpn,
  };
  // Issue #16: this save lands at the end of a multi-minute remote pipeline,
  // and nothing refreshes inventory mid-job (the MCP process has no
  // per-request reload the way the web service does). Reload from disk first
  // and derive the new guests array from that fresh copy, so an edit another
  // process made meanwhile (a Dashboard/Settings change, a CLI run) isn't
  // silently reverted by a wholesale save from the job-start snapshot.
  refreshInventory(deps.inventory, deps.inventoryPath);
  const guests = [...deps.inventory.guests, newGuest];
  saveInventory(deps.inventoryPath, { ...deps.inventory, guests });
  deps.inventory.guests = guests;

  logInfo(`${hostname} is up at ${stripCidr(mid.ip)}. Management API: http://${stripCidr(mid.ip)}:8080/status`);
  return { createCommand, mid, previewServer, applied: true };
}
