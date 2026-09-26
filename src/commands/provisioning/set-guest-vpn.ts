import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory, GuestEntry } from '../../lib/inventory.ts';
import { saveInventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { parseNet0, setNet0Gateway, buildDnsmasqInstallScript, buildDnsmasqRemoveScript } from '../../lib/guest-vpn.ts';
import { logInfo } from '../../lib/log.ts';
import { settingFix } from '../../lib/settings-hint.ts';

export interface SetGuestVpnOptions {
  guest: string;
  // The name of a gateway guest (GuestEntry.vpnGateway set), or 'none' to
  // route back through the LAN router directly.
  vpn: string | 'none';
  apply?: boolean;
}

// --vpn none restores the guest's LAN default route. The address comes
// from the parent host's own midScheme.gateway -- the same gateway
// resolveMid hands a guest at creation time -- rather than a constant, so
// there is no second copy of it to disagree with inventory.
function resolveGatewayIp(inventory: Inventory, vpn: string | 'none', guest: GuestEntry): string {
  if (vpn === 'none') {
    const parent = inventory.hosts.find((h) => h.name === guest.host);
    if (!parent?.midScheme) {
      throw new Error(
        `'${guest.host}' has no midScheme, so there is no LAN gateway to restore '${guest.name}' to`
      );
    }
    return parent.midScheme.gateway;
  }
  const gateway = inventory.guests.find((g) => g.name === vpn && g.vpnGateway);
  if (!gateway?.ip) {
    throw new Error(
      `No guest in inventory has 'vpnGateway: ${vpn}' set with an ip -- deploy one first (deploy-vpn-gateway --name ${vpn} --vpn <nordvpn|pia>)`
    );
  }
  return gateway.ip;
}

async function resolveProviderDns(gatewayIp: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`http://${gatewayIp}:8080/status`);
  if (!response.ok) {
    throw new Error(`Failed to read ${gatewayIp}:8080/status (status ${response.status}) -- is the gateway's agent running?`);
  }
  const body = (await response.json()) as { dns?: string };
  if (!body.dns) {
    throw new Error(`${gatewayIp}:8080/status returned no dns -- is the gateway connected yet?`);
  }
  return body.dns;
}

export async function runSetGuestVpn(
  opts: SetGuestVpnOptions,
  deps: { ssh: SSHClient; inventory: Inventory; inventoryPath: string; fetchImpl?: typeof fetch }
): Promise<{ netScript: string; dnsScript?: string; applied: boolean }> {
  const guest = deps.inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || guest.type !== 'lxc') {
    throw new Error(`'${opts.guest}' is not an lxc guest in inventory`);
  }
  // Routing a gateway through a gateway (including itself) is a routing
  // loop that also cuts the gateway off from the internet -- self-heal
  // can't recover it, every guest behind it goes down too, and fixing it
  // needs console access.
  if (guest.vpnGateway) {
    throw new Error(
      `'${opts.guest}' is itself a VPN gateway (vpnGateway: ${guest.vpnGateway}) -- refusing to route it through a gateway (including itself)`
    );
  }
  const gatewayIp = resolveGatewayIp(deps.inventory, opts.vpn, guest);

  const configResult = await runRemote(deps.ssh, deps.inventory, guest.host, `pct config ${guest.vmid}`);
  if (configResult.code !== 0) {
    throw new Error(`Failed to read pct config for vmid ${guest.vmid} on ${guest.host}`);
  }
  const net0 = parseNet0(configResult.stdout);
  if (!net0) {
    throw new Error(`Could not parse net0 from ${opts.guest}'s pct config -- refusing to guess its network config`);
  }

  // Rewrite only gw= in the guest's existing net0 value rather than
  // rebuilding it from a partial parse -- hwaddr=/type=/tag=/mtu=/firewall=
  // /rate= all have to survive untouched. -nameserver is folded into the
  // same pct set call (rather than written from inside the guest) because
  // Proxmox rewrites /etc/resolv.conf from this exact config value on
  // every container boot -- confirmed live that a guest-side resolv.conf
  // write gets silently undone by the reboot this command performs right
  // after. For nordvpn/pia this points at the guest's own dnsmasq stub
  // (127.0.0.1); for none it points straight at the configured dnsServer,
  // same as before dnsmasq/split-DNS existed.
  const dnsServer = deps.inventory.dnsServer;
  if (dnsServer === undefined) {
    throw new Error(`dnsServer is not set -- ${settingFix('dnsServer', '<ip>')}`);
  }
  const nameserver = opts.vpn === 'none' ? dnsServer : '127.0.0.1';
  const netScript = `pct set ${guest.vmid} -net0 ${setNet0Gateway(net0, gatewayIp)} -nameserver ${nameserver}`;

  let dnsScript: string;
  if (opts.vpn === 'none') {
    dnsScript = buildDnsmasqRemoveScript();
  } else {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const providerDns = await resolveProviderDns(gatewayIp, fetchImpl);
    dnsScript = buildDnsmasqInstallScript(deps.inventory.domain, providerDns, dnsServer);
  }

  if (!opts.apply) {
    return { netScript, dnsScript, applied: false };
  }

  logInfo(`Pointing ${opts.guest}'s default route at ${gatewayIp}...`);
  const netResult = await runRemote(deps.ssh, deps.inventory, guest.host, netScript);
  if (netResult.code !== 0) {
    throw new Error(`pct set failed on ${guest.host} for vmid ${guest.vmid} (exit ${netResult.code}): ${netResult.stderr || netResult.stdout}`);
  }

  logInfo(`Configuring DNS on ${opts.guest}...`);
  const dnsResult = await runRemote(deps.ssh, deps.inventory, opts.guest, dnsScript);
  if (dnsResult.code !== 0) {
    throw new Error(
      `${opts.guest}'s default route now points at ${gatewayIp}, but configuring DNS failed: ${dnsResult.stderr || dnsResult.stdout} -- the guest keeps working on its old route until the reboot that would apply the new one. Fix DNS and re-run before rebooting.`
    );
  }

  logInfo(`Rebooting ${opts.guest}...`);
  const rebootResult = await runRemote(deps.ssh, deps.inventory, guest.host, `pct reboot ${guest.vmid}`);
  if (rebootResult.code !== 0) {
    throw new Error(`Reboot failed on ${guest.host} for vmid ${guest.vmid} (exit ${rebootResult.code}): ${rebootResult.stderr || rebootResult.stdout}`);
  }

  const vpn = opts.vpn === 'none' ? undefined : opts.vpn;
  const guests = deps.inventory.guests.map((g) => (g.name === opts.guest ? { ...g, vpn } : g));
  saveInventory(deps.inventoryPath, { ...deps.inventory, guests });
  deps.inventory.guests = guests;

  return { netScript, dnsScript, applied: true };
}
