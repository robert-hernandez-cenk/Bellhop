import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNet0,
  setNet0Gateway,
  setNet0Ip,
  parseIpconfig0,
  setIpconfig0Ip,
  buildDnsmasqInstallScript,
  buildDnsmasqRemoveScript,
} from '../../src/lib/guest-vpn.ts';

test('parseNet0 returns the whole raw net0 value from a real pct config line', () => {
  const pctConfig = [
    'arch: amd64',
    'net0: name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,type=veth',
    'ostype: debian',
  ].join('\n');
  // Returned verbatim, not decomposed -- every field has to be available to
  // set-guest-vpn so its gw= rewrite can leave the rest alone.
  assert.equal(parseNet0(pctConfig), 'name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,type=veth');
});

test('parseNet0 returns undefined when there is no net0 line', () => {
  assert.equal(parseNet0('arch: amd64\nostype: debian'), undefined);
});

test('setNet0Gateway rewrites only gw= and preserves every other field byte-for-byte', () => {
  const net0 = 'name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,tag=20,mtu=1420,firewall=1,type=veth';
  const updated = setNet0Gateway(net0, '192.168.1.15');
  assert.equal(
    updated,
    'name=eth0,bridge=vmbr0,gw=192.168.1.15,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,tag=20,mtu=1420,firewall=1,type=veth'
  );
  // Spelled out individually: dropping hwaddr makes Proxmox mint a new MAC
  // (breaking DHCP reservations), and dropping tag takes the guest off its
  // VLAN entirely -- both silent, both were happening before.
  assert.ok(updated.includes('hwaddr=BC:24:11:AA:BB:CC'));
  assert.ok(updated.includes('tag=20'));
  assert.ok(updated.includes('mtu=1420'));
  assert.ok(updated.includes('firewall=1'));
  assert.ok(updated.includes('type=veth'));
  // Only the one key changed: same field count, same order.
  assert.deepEqual(
    updated.split(',').map((f) => f.split('=')[0]),
    net0.split(',').map((f) => f.split('=')[0])
  );
});

test('setNet0Gateway appends gw= when the interface has none (a DHCP guest)', () => {
  assert.equal(
    setNet0Gateway('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth', '192.168.1.15'),
    'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth,gw=192.168.1.15'
  );
});

test('setNet0Gateway rewrites a leading gw= without corrupting the value', () => {
  assert.equal(setNet0Gateway('gw=192.168.3.1,name=eth0,bridge=vmbr0', '192.168.1.15'), 'gw=192.168.1.15,name=eth0,bridge=vmbr0');
});

test('setNet0Gateway does not mistake gw6= or a trailing -gw= lookalike for the gw key', () => {
  const net0 = 'name=eth0,bridge=vmbr0,gw6=fe80::1,ip=192.168.1.10/16';
  // gw6= is a different key -- it must be left alone, and gw= appended.
  assert.equal(setNet0Gateway(net0, '192.168.1.15'), 'name=eth0,bridge=vmbr0,gw6=fe80::1,ip=192.168.1.10/16,gw=192.168.1.15');
});

test('setNet0Ip rewrites only ip= and preserves every other field byte-for-byte, including gw=', () => {
  const net0 = 'name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.12/16,tag=20,mtu=1420,firewall=1,type=veth';
  const updated = setNet0Ip(net0, '192.168.2.12/16');
  assert.equal(
    updated,
    'name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.2.12/16,tag=20,mtu=1420,firewall=1,type=veth'
  );
  // gw= (and everything else) must survive untouched -- migrate-guest never
  // has a reason to touch gw= (resolveMid returns the same gateway
  // regardless of host role), so a VPN-routed guest's gw= must not silently
  // reset to the LAN gateway during a migration.
  assert.ok(updated.includes('gw=192.168.3.1'));
  assert.ok(updated.includes('hwaddr=BC:24:11:AA:BB:CC'));
  assert.ok(updated.includes('tag=20'));
});

test('setNet0Ip appends ip= when the interface has none', () => {
  assert.equal(
    setNet0Ip('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,type=veth', '192.168.2.12/16'),
    'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,type=veth,ip=192.168.2.12/16'
  );
});

test('parseIpconfig0 returns the whole raw ipconfig0 value from a real qm config line', () => {
  const qmConfig = ['agent: 1', 'ipconfig0: ip=192.168.1.20/16,gw=192.168.3.1', 'ostype: l26'].join('\n');
  assert.equal(parseIpconfig0(qmConfig), 'ip=192.168.1.20/16,gw=192.168.3.1');
});

test('parseIpconfig0 returns undefined when there is no ipconfig0 line', () => {
  assert.equal(parseIpconfig0('agent: 1\nostype: l26'), undefined);
});

test('setIpconfig0Ip rewrites only ip= and preserves gw= byte-for-byte', () => {
  assert.equal(setIpconfig0Ip('ip=192.168.1.20/16,gw=192.168.3.1', '192.168.2.20/16'), 'ip=192.168.2.20/16,gw=192.168.3.1');
});

test('setIpconfig0Ip appends ip= when the VM has no ip= yet', () => {
  assert.equal(setIpconfig0Ip('gw=192.168.3.1', '192.168.2.20/16'), 'gw=192.168.3.1,ip=192.168.2.20/16');
});

test('buildDnsmasqInstallScript forwards the domain to the configured dnsServer and everything else to the provider DNS', () => {
  const script = buildDnsmasqInstallScript('example.com', '103.86.96.100', '192.168.1.254');
  assert.match(script, /server=\/example\.com\/192.168.1.254/);
  assert.match(script, /server=103\.86\.96\.100/);
  // Doesn't write /etc/resolv.conf itself -- Proxmox rewrites that file
  // from the container's own -nameserver config on every boot, silently
  // undoing a guest-side write during set-guest-vpn's own reboot.
  // set-guest-vpn folds -nameserver 127.0.0.1 into the pct set call
  // instead, so Proxmox persists it.
  assert.ok(!script.includes('/etc/resolv.conf'));
  // Must *enable* dnsmasq, not just restart it -- set-guest-vpn always
  // reboots the guest right after this script runs, and a merely-restarted
  // (never-enabled) service doesn't come back up after that reboot, leaving
  // resolv.conf pointed at a stub resolver that isn't running. Confirmed
  // live on readarr-lxc: dnsmasq was installed and configured correctly but
  // sat disabled/inactive after the post-install reboot, breaking all DNS.
  assert.match(script, /systemctl enable dnsmasq/);
  assert.match(script, /systemctl restart dnsmasq/);
});

test('buildDnsmasqInstallScript points the domain at the configured dnsServer', () => {
  const script = buildDnsmasqInstallScript('example.com', '10.64.0.1', '10.0.0.53');
  assert.ok(script.includes('server=/example.com/10.0.0.53'));
  assert.ok(script.includes('server=10.64.0.1'));
});

test('buildDnsmasqRemoveScript removes the split-DNS config and disables dnsmasq, without touching resolv.conf', () => {
  const script = buildDnsmasqRemoveScript();
  assert.match(script, /rm -f \/etc\/dnsmasq\.d\/vpn-split-dns\.conf/);
  assert.match(script, /systemctl disable --now dnsmasq/);
  // Same reasoning as the install script -- resolv.conf is set via
  // set-guest-vpn's -nameserver <dnsServer>, not written from here.
  assert.ok(!script.includes('/etc/resolv.conf'));
});
