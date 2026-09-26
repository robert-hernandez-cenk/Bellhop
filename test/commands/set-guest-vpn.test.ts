import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { runSetGuestVpn } from '../../src/commands/provisioning/set-guest-vpn.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const NET0_LINE = 'net0: name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,type=veth';

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'nordvpn-gateway-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.168.1.15', vpnGateway: 'nordvpn' },
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.10' },
    ],
  };
}

function tempInventoryPath(inv: Inventory): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

function fakeFetch(status: { dns?: string }, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => status }) as unknown as Response) as typeof fetch;
}

test('runSetGuestVpn rejects a non-lxc / unknown guest', async () => {
  const inventory = baseInventory();
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runSetGuestVpn(
        { guest: 'nope', vpn: 'nordvpn-gateway-lxc' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
      ),
    /is not an lxc guest in inventory/
  );
});

test('runSetGuestVpn throws when no guest matches the requested gateway name', async () => {
  const inventory = baseInventory();
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    throw new Error(`unexpected command: ${c}`);
  });
  await assert.rejects(
    () =>
      runSetGuestVpn(
        { guest: 'media', vpn: 'no-such-gateway-lxc' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
      ),
    /No guest in inventory has 'vpnGateway: no-such-gateway-lxc'/
  );
});

test('runSetGuestVpn throws when the requested name matches a guest that is not flagged vpnGateway', async () => {
  const inventory = baseInventory();
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    throw new Error(`unexpected command: ${c}`);
  });
  await assert.rejects(
    () =>
      runSetGuestVpn(
        // 'media' exists in inventory but has no vpnGateway set -- routing
        // through it must fail the same way a nonexistent name does, not
        // silently treat it as a (non-)gateway.
        { guest: 'media', vpn: 'media' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
      ),
    /No guest in inventory has 'vpnGateway: media'/
  );
});

test('runSetGuestVpn dry run resolves the gateway gw= and provider DNS without applying', async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    throw new Error(`unexpected command: ${c}`);
  });
  const result = await runSetGuestVpn(
    { guest: 'media', vpn: 'nordvpn-gateway-lxc' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
  );
  assert.equal(result.applied, false);
  // Only gw= changes; hwaddr=/type=/name=/bridge=/ip= all survive verbatim
  // from NET0_LINE (rebuilding net0 from a partial parse used to drop them).
  // -nameserver 127.0.0.1 is folded into the same pct set call so Proxmox
  // itself persists it across the reboot -- a guest-side resolv.conf write
  // gets silently reverted at boot otherwise.
  assert.equal(
    result.netScript,
    'pct set 105 -net0 name=eth0,bridge=vmbr0,gw=192.168.1.15,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,type=veth -nameserver 127.0.0.1'
  );
  assert.match(result.dnsScript!, /server=103\.86\.96\.100/);
  assert.ok(!result.dnsScript!.includes('/etc/resolv.conf'), 'resolv.conf is set via pct -nameserver, not written from inside the guest');
  assert.equal(ssh.history.length, 1, 'only the pct config read -- no mutation in dry run');
});

test('runSetGuestVpn --vpn none points gw at the LAN router and skips the provider DNS fetch', async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  // The gateway restored here comes from the parent host's own midScheme,
  // not a hardcoded constant -- picking the same value NET0_LINE's existing
  // gw= already has isn't required, just convenient for this test.
  inventory.hosts[0].midScheme = { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    throw new Error(`unexpected command: ${c}`);
  });
  const result = await runSetGuestVpn(
    { guest: 'media', vpn: 'none' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({}, false) } // a failing fetchImpl proves it's never called
  );
  assert.equal(
    result.netScript,
    'pct set 105 -net0 name=eth0,bridge=vmbr0,gw=192.168.3.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/16,type=veth -nameserver 10.0.0.53'
  );
  assert.ok(!result.dnsScript!.includes('/etc/resolv.conf'), 'resolv.conf is set via pct -nameserver, not written from inside the guest');
});

test('runSetGuestVpn refuses to route a VPN gateway guest through a gateway', async () => {
  const inventory = baseInventory();
  const ssh = new FakeSSHClient((_t, _u, c) => {
    throw new Error(`no ssh call should be made: ${c}`);
  });
  await assert.rejects(
    () =>
      runSetGuestVpn(
        // The gateway itself: pointing its default route at a gateway (its
        // own IP included) is a routing loop that also cuts it off from the
        // internet, so self-heal can't recover and every guest behind it
        // goes down -- recovery needs console access.
        { guest: 'nordvpn-gateway-lxc', vpn: 'nordvpn-gateway-lxc' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
      ),
    /is itself a VPN gateway/
  );
  assert.equal(ssh.history.length, 0, 'the check must happen before any remote call');
});

test('runSetGuestVpn apply runs gw change, dns config, reboot, and records vpn in inventory', async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  const invPath = tempInventoryPath(inventory);
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runSetGuestVpn(
    { guest: 'media', vpn: 'nordvpn-gateway-lxc', apply: true },
    { ssh, inventory, inventoryPath: invPath, fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
  );
  assert.equal(result.applied, true);
  assert.ok(ssh.history.some((c) => c.command.startsWith('pct set 105 -net0')));
  assert.ok(ssh.history.some((c) => c.command === 'pct reboot 105'));

  const saved = loadInventory(invPath);
  assert.equal(saved.guests.find((g) => g.name === 'media')?.vpn, 'nordvpn-gateway-lxc');
});

test('runSetGuestVpn routes to the specific gateway named, even when another guest shares its provider', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    dnsServer: '10.0.0.53',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'nordvpn-us-gw-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.168.1.15', vpnGateway: 'nordvpn' },
      { name: 'nordvpn-eu-gw-lxc', type: 'lxc', vmid: 4017, host: 'pve1', ip: '192.168.1.17', vpnGateway: 'nordvpn' },
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.10' },
    ],
  };
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    throw new Error(`unexpected command: ${c}`);
  });
  const result = await runSetGuestVpn(
    { guest: 'media', vpn: 'nordvpn-eu-gw-lxc' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '37.19.221.1' }) }
  );
  assert.match(result.netScript, /gw=192.168.1.17/, 'must route through the EU gateway specifically, not the US one');
});

test('runSetGuestVpn apply throws before rebooting when DNS config fails, without reverting the gw change', async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  const invPath = tempInventoryPath(inventory);
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'pct config 105') return { stdout: NET0_LINE, stderr: '', code: 0 };
    if (c.startsWith('pct set 105 -net0')) return { stdout: '', stderr: '', code: 0 };
    if (c.includes('dnsmasq')) return { stdout: '', stderr: 'apt-get failed', code: 1 };
    throw new Error(`unexpected command: ${c}`);
  });
  await assert.rejects(
    () =>
      runSetGuestVpn(
        { guest: 'media', vpn: 'nordvpn-gateway-lxc', apply: true },
        { ssh, inventory, inventoryPath: invPath, fetchImpl: fakeFetch({ dns: '103.86.96.100' }) }
      ),
    /configuring DNS failed/
  );
  assert.ok(ssh.history.some((c) => c.command.startsWith('pct set 105 -net0')), 'gw change should have already run');
  assert.ok(!ssh.history.some((c) => c.command === 'pct reboot 105'), 'reboot must not run after a DNS failure');
});

test('runSetGuestVpn throws when dnsServer is unset', async () => {
  const inventory = baseInventory();
  // A midScheme is required here so resolveGatewayIp succeeds first --
  // otherwise this test would pass for the wrong reason, catching the
  // missing-gateway error instead of the missing-dnsServer one.
  inventory.hosts[0].midScheme = { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '10.0.0.1' };
  const ssh = new FakeSSHClient(() => ({ stdout: NET0_LINE, stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runSetGuestVpn(
        { guest: 'media', vpn: 'none' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '10.64.0.1' }) }
      ),
    /dnsServer is not set -- run: bellhop set-config dnsServer <ip> --apply, or set it on the web UI's Settings page/
  );
});

test("runSetGuestVpn --vpn none restores the parent host's midScheme gateway", async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  inventory.hosts[0].midScheme = { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '10.0.0.1' };
  const ssh = new FakeSSHClient(() => ({ stdout: NET0_LINE, stderr: '', code: 0 }));
  const result = await runSetGuestVpn(
    { guest: 'media', vpn: 'none' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '10.64.0.1' }) }
  );
  assert.ok(result.netScript.includes('gw=10.0.0.1'));
  assert.ok(result.netScript.includes('-nameserver 10.0.0.53'));
});

test('runSetGuestVpn --vpn none throws when the parent host has no midScheme', async () => {
  const inventory = baseInventory();
  inventory.dnsServer = '10.0.0.53';
  const ssh = new FakeSSHClient(() => ({ stdout: NET0_LINE, stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runSetGuestVpn(
        { guest: 'media', vpn: 'none' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), fetchImpl: fakeFetch({ dns: '10.64.0.1' }) }
      ),
    /has no midScheme/
  );
});
