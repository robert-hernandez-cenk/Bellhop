// Returns the raw net0 value (everything after "net0: ") from a
// `pct config <vmid>` output, e.g.
// "name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=...,ip=192.168.1.10/16,type=veth"
// -- returned as-is (not decomposed into fields) so set-guest-vpn's gw=
// rewrite can preserve every field it doesn't need to change (hwaddr, type,
// tag, mtu, firewall, rate, ...) rather than silently dropping them by
// reconstructing the string from a partial parse. Dropping hwaddr= alone
// makes Proxmox generate a *new* MAC (breaking DHCP reservations and
// anything else keyed on it), and dropping a tag= takes the guest off its
// VLAN entirely.
export function parseNet0(pctConfig: string): string | undefined {
  const line = pctConfig.split('\n').find((l) => l.trim().startsWith('net0:'));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(':') + 1).trim();
  return value || undefined;
}

// Rewrites (or appends) a single `key=` within a raw net0/ipconfig0 value,
// leaving every other key byte-for-byte untouched -- shared by every
// surgical single-field rewrite below (gw= for set-guest-vpn, ip= for
// migrate-guest's net0/ipconfig0 reconfiguration). `(^|,)` anchors the match
// to a real key boundary so e.g. a `gw` rewrite never mistakes `gw6=` (a
// different key) for `gw=`.
function setKey(rawValue: string, key: string, newValue: string): string {
  const pattern = new RegExp(`(^|,)${key}=[^,]*`);
  if (pattern.test(rawValue)) {
    return rawValue.replace(pattern, (_match, prefix: string) => `${prefix}${key}=${newValue}`);
  }
  return `${rawValue},${key}=${newValue}`;
}

// Rewrites (or appends) the gw= key within a raw net0 value, leaving every
// other key byte-for-byte untouched.
export function setNet0Gateway(net0Value: string, gatewayIp: string): string {
  return setKey(net0Value, 'gw', gatewayIp);
}

// migrate-guest's sibling of setNet0Gateway: rewrites only ip= within a raw
// net0 value (LXC), leaving gw=/hwaddr=/tag=/mtu=/firewall=/rate=/etc.
// untouched -- migrating a guest between hosts changes its IP but, on this
// toolkit's single flat LAN (resolveMid always returns the same gateway
// regardless of host role), never its gateway, so gw= must never be part of
// this rewrite the way it is for set-guest-vpn.
export function setNet0Ip(net0Value: string, ipCidr: string): string {
  return setKey(net0Value, 'ip', ipCidr);
}

// Returns the raw ipconfig0 value (everything after "ipconfig0: ") from a
// `qm config <vmid>` output, e.g. "ip=192.168.1.10/16,gw=192.168.3.1" --
// mirrors parseNet0 for VM guests (cloud-init's ipconfig0 is net0's VM
// equivalent).
export function parseIpconfig0(qmConfig: string): string | undefined {
  const line = qmConfig.split('\n').find((l) => l.trim().startsWith('ipconfig0:'));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(':') + 1).trim();
  return value || undefined;
}

// migrate-guest's VM-guest sibling of setNet0Ip: rewrites only ip= within a
// raw ipconfig0 value, leaving gw= (if the VM has cloud-init configured with
// one) and anything else on that line untouched.
export function setIpconfig0Ip(ipconfig0Value: string, ipCidr: string): string {
  return setKey(ipconfig0Value, 'ip', ipCidr);
}

// Installs a local dnsmasq stub resolver so *.{{domain}} resolves via
// the configured dnsServer over the guest's unchanged /16 LAN route, and
// everything else (the catch-all) resolves via the VPN provider's own DNS,
// which rides the tunnel since it isn't in the guest's own LAN range.
// Does NOT write /etc/resolv.conf itself -- confirmed live that Proxmox
// rewrites that file from the container's own `-nameserver`
// config on every boot, silently undoing a guest-side write during the
// reboot set-guest-vpn always performs right after this script runs.
// set-guest-vpn instead folds `-nameserver 127.0.0.1` into the same `pct set`
// call that changes gw=, so Proxmox itself persists the value that points at
// this stub resolver.
export function buildDnsmasqInstallScript(domain: string, providerDns: string, dnsServer: string): string {
  const delimiter = 'VPN_GUEST_DNSMASQ_EOF';
  return [
    'set -e',
    'apt-get update && apt-get install -y dnsmasq',
    `cat > /etc/dnsmasq.d/vpn-split-dns.conf <<'${delimiter}'`,
    'no-resolv',
    `server=/${domain}/${dnsServer}`,
    `server=${providerDns}`,
    delimiter,
    // enable (survives set-guest-vpn's own post-script reboot -- a
    // merely-restarted, never-enabled service doesn't come back up after
    // that) *and* restart (picks up the new config immediately even if
    // dnsmasq was already running from a prior provider switch, since
    // `enable` alone is a no-op on an already-active unit).
    'systemctl enable dnsmasq',
    'systemctl restart dnsmasq',
  ].join('\n');
}

// set-guest-vpn's --vpn none inverse: removes the split-DNS config, no
// local resolver in the path at all. Also doesn't touch /etc/resolv.conf
// itself, for the same reason buildDnsmasqInstallScript doesn't --
// set-guest-vpn folds `-nameserver <dnsServer>` (the configured dnsServer)
// into the same `pct set` call instead, so Proxmox persists it across the
// reboot.
export function buildDnsmasqRemoveScript(): string {
  return ['set -e', 'rm -f /etc/dnsmasq.d/vpn-split-dns.conf', 'systemctl disable --now dnsmasq 2>/dev/null || true'].join('\n');
}
