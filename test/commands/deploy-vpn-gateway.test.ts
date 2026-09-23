import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import { runDeployVpnGateway, buildGatewayProvisionScript, buildCredentialsEnv } from '../../src/commands/provisioning/deploy-vpn-gateway.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeGoBuilder, fakeNordVpnFetch as fakeFetch, fakePiaFetch } from '../support/fake-go-builder-and-fetch.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      storages: [{ name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true }],
    },
  ],
  guests: [],
};

function tempInventoryPath(inv: Inventory): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

test('buildGatewayProvisionScript pct-pushes the pre-uploaded binary instead of embedding it', () => {
  const credentialsEnv = buildCredentialsEnv({ vpn: 'nordvpn', accessToken: 'my-token', gatewayLanIp: '192.168.1.15' });
  const script = buildGatewayProvisionScript(4015, credentialsEnv, '/tmp/vpn-gateway-agent-4015.bin');
  const lines = script.split('\n');

  // Host-side steps, in order. The two pct exec ... bash -c entries below
  // are multi-line (heredocs), so they're matched by their first line.
  assert.equal(lines[0], 'set -e');
  assert.equal(lines[1], `pct exec 4015 -- bash -c 'mkdir -p /etc/vpn-gateway`);
  assert.ok(script.includes('NORDVPN_ACCESS_TOKEN=my-token'));
  assert.ok(script.includes('VPN_PROVIDER=nordvpn'));
  assert.ok(script.includes('chmod 600 /etc/vpn-gateway/credentials.env'));
  assert.ok(script.includes('GATEWAY_LAN_IP=192.168.1.15'));

  // pct push and the temp-file cleanup run on the HOST (no pct exec
  // wrapper) -- pct push is what copies host -> container, and --perms 0755
  // is what makes the pushed binary executable (there is no later chmod).
  assert.ok(
    lines.includes(`pct push 4015 '/tmp/vpn-gateway-agent-4015.bin' /usr/local/bin/vpn-gateway-agent --perms 0755`),
    `expected a host-side pct push line, got:\n${script}`
  );
  assert.ok(lines.includes(`rm -f '/tmp/vpn-gateway-agent-4015.bin'`), 'the host-side temp binary should be cleaned up');

  assert.ok(script.includes('ExecStart=/usr/local/bin/vpn-gateway-agent'), 'the systemd unit is still written inline');
  assert.equal(lines[lines.length - 2], 'pct exec 4015 -- systemctl daemon-reload');
  assert.equal(lines[lines.length - 1], 'pct exec 4015 -- systemctl enable --now vpn-gateway-agent');

  // The whole point of Fix A: nothing binary-shaped goes into a command
  // string, so the script stays far below Linux's 128KB MAX_ARG_STRLEN cap
  // on a single exec argument regardless of how large the agent gets.
  assert.ok(!script.includes('base64'), 'no base64 encode/decode step should remain');
  assert.ok(script.length < 2048, `provisioning script should stay tiny, was ${script.length} bytes`);
});

test('runDeployVpnGateway throws when NORDVPN_ACCESS_TOKEN is unset', async () => {
  delete process.env.NORDVPN_ACCESS_TOKEN;
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
      ),
    /NordVPN access token is not set -- fill in the Access Token field on the Deploy VPN Gateway form, or set NORDVPN_ACCESS_TOKEN for CLI use/
  );
});

test('runDeployVpnGateway uses an operator-supplied accessToken over process.env', async () => {
  delete process.env.NORDVPN_ACCESS_TOKEN;
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', accessToken: 'form-supplied-token' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
  );
  assert.equal(result.applied, false);
});

test('runDeployVpnGateway uses operator-supplied piaUsername/piaPassword over process.env', async () => {
  delete process.env.PIA_USERNAME;
  delete process.env.PIA_PASSWORD;
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 16, name: 'pia-gateway-lxc', vpn: 'pia', piaUsername: 'p0123456', piaPassword: 'hunter2' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakePiaFetch() }
  );
  assert.equal(result.applied, false);
});

test('runDeployVpnGateway throws a clear error for an unrecognized --vpn value', async () => {
  // Commander's `--vpn <nordvpn|pia>` is only a --help placeholder, not a
  // validator -- opts.vpn is typed 'nordvpn' | 'pia' but nothing stops a
  // typo like 'Pia' from actually reaching this function at runtime, so the
  // cast below simulates that. Before this fix, a value that merely wasn't
  // 'nordvpn' fell through to the PIA branch unguarded.
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 15, name: 'pia-gateway-lxc', vpn: 'Pia' as unknown as 'pia' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
      ),
    /--vpn must be 'nordvpn' or 'pia', got 'Pia'/
  );
  assert.equal(ssh.history.length, 0, 'an invalid --vpn should be rejected before any ssh call is made');
});

test('runDeployVpnGateway rejects a name that collides with an existing guest before any ssh call is made', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const inventoryWithExistingGuest: Inventory = {
    ...inventory,
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' }],
  };
  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 15, name: 'plex-lxc', vpn: 'nordvpn' },
        { ssh, inventory: inventoryWithExistingGuest, inventoryPath: tempInventoryPath(inventoryWithExistingGuest), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
      ),
    /A guest named 'plex-lxc' already exists in inventory/
  );
  assert.equal(ssh.history.length, 0, 'a colliding --name should be rejected before any ssh call is made');
});

test('runDeployVpnGateway allows a second gateway for a provider that already has one in inventory', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const goBuilder = new FakeGoBuilder();
  const inventoryWithExistingGateway: Inventory = {
    ...inventory,
    guests: [{ name: 'nordvpn-us-gw-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.168.1.15', vpnGateway: 'nordvpn' }],
  };
  const invPath = tempInventoryPath(inventoryWithExistingGateway);

  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 17, name: 'nordvpn-eu-gw-lxc', vpn: 'nordvpn', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
    { ssh, inventory: inventoryWithExistingGateway, inventoryPath: invPath, goBuilder, fetchImpl: fakeFetch() }
  );

  assert.equal(result.applied, true);
  const saved = loadInventory(invPath);
  assert.equal(saved.guests.filter((g) => g.vpnGateway === 'nordvpn').length, 2);
  assert.ok(saved.guests.some((g) => g.name === 'nordvpn-us-gw-lxc'), 'the original gateway must be untouched');
  assert.ok(saved.guests.some((g) => g.name === 'nordvpn-eu-gw-lxc'), 'the new gateway must use the operator-chosen name');
});

test('runDeployVpnGateway dry run resolves authorized_keys and the preview server, makes no other ssh calls', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
  );
  assert.equal(result.applied, false);
  assert.match(result.createCommand, /pct create 4015/);
  assert.match(result.createCommand, /--unprivileged 0/);
  assert.match(result.createCommand, /wireguard-tools iptables/);
  assert.equal(result.previewServer.hostname, 'nl123.nordvpn.com');
  assert.equal(result.previewServer.country, 'Netherlands');
  assert.deepEqual(calls, ['cat ~/.ssh/authorized_keys 2>/dev/null']);
});

test('runDeployVpnGateway uses the operator-chosen storage over the auto-picked one', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', storage: 'nas-proxmox' },
    { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
  );
  assert.match(result.createCommand, /--rootfs 'nas-proxmox':8/);
});

test('runDeployVpnGateway apply creates the LXC, builds+pushes the agent, and records vpnGateway in inventory', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const goBuilder = new FakeGoBuilder();
  const invPath = tempInventoryPath(inventory);

  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
    { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder, fetchImpl: fakeFetch() }
  );

  assert.equal(result.applied, true);
  assert.equal(goBuilder.built.length, 1);

  // The binary travels over SFTP, never inside a command string: Linux caps
  // one exec argv element at 128KB and the real agent is ~9-10MB, so a
  // base64-in-bash-c push fails with E2BIG before running.
  assert.equal(ssh.putFileHistory.length, 1, 'the agent binary should be uploaded exactly once');
  assert.deepEqual(ssh.putFileHistory[0], {
    sshTarget: 'pve1.local',
    sshUser: 'root',
    remotePath: '/tmp/vpn-gateway-agent-4015.bin',
    content: Buffer.from('fake-agent-binary'),
  });

  // Ordered-sequence assertion (not just membership) -- this fixture host
  // has no authorized_keys content (the responder returns empty stdout for
  // every command), so readHostAuthorizedKeys resolves to undefined and the
  // SSH-key-push call is skipped entirely: exactly 3 calls, in order --
  // the authorized_keys probe (made unconditionally, before pct create, so
  // the dry-run preview is provably identical to what apply sends -- see
  // CLAUDE.md's "Dry-run convention"), pct create, then the single combined
  // provision script. This would catch the provisioning script running
  // before pct create, running twice, or an unexpected extra call.
  const commands = ssh.history.map((c) => c.command);
  assert.equal(commands.length, 3, `expected exactly 3 ssh calls, got: ${commands.join(' | ')}`);
  assert.equal(commands[0], 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(commands[1], /^pct create 4015/);
  assert.match(commands[1], /--unprivileged 0/);
  assert.match(commands[1], /wireguard-tools iptables/);

  // The third call is exactly the provisioning script built for this vmid,
  // token and uploaded-binary path -- pinned against the builder, whose own
  // exact output is asserted line-by-line in its dedicated test below.
  assert.equal(
    commands[2],
    buildGatewayProvisionScript(
      4015,
      buildCredentialsEnv({ vpn: 'nordvpn', accessToken: 'my-token', gatewayLanIp: '192.168.1.15' }),
      '/tmp/vpn-gateway-agent-4015.bin'
    )
  );
  assert.ok(!commands[2].includes('base64'), 'the binary must never be base64-embedded in a command string again');
  assert.ok(!commands[2].includes('fake-agent-binary'), 'the binary bytes must never appear in a command string');
  assert.ok(
    commands.every((c) => c.length < 4096),
    `no command should be anywhere near MAX_ARG_STRLEN; longest was ${Math.max(...commands.map((c) => c.length))} bytes`
  );

  const saved = loadInventory(invPath);
  const gateway = saved.guests.find((g) => g.name === 'nordvpn-gateway-lxc');
  assert.equal(gateway?.vpnGateway, 'nordvpn');
  assert.equal(gateway?.vmid, 4015);
  assert.equal(gateway?.ip, '192.168.1.15');
});

test('runDeployVpnGateway apply rejects and leaves inventory unwritten when the agent never reports connected', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const goBuilder = new FakeGoBuilder();
  const invPath = tempInventoryPath(inventory);

  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
        { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder, fetchImpl: fakeFetch(false) }
      ),
    /never reported connected/
  );

  // The provisioning script did run (so this isn't passing vacuously on an
  // earlier failure) -- it's specifically the /status check that stopped a
  // forked-but-not-connected agent from being recorded as a live gateway.
  assert.ok(ssh.history.some((c) => c.command.includes('systemctl enable --now vpn-gateway-agent')));

  const saved = loadInventory(invPath);
  assert.equal(saved.guests.length, 0);
});

test('runDeployVpnGateway apply rejects and leaves inventory unchanged when pct create fails', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c.startsWith('pct create')) {
      return { stdout: '', stderr: 'pct create failed: no such storage', code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const goBuilder = new FakeGoBuilder();
  const invPath = tempInventoryPath(inventory);

  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', apply: true },
        { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder, fetchImpl: fakeFetch() }
      ),
    /pct create failed on pve1/
  );

  // Cross-compiling/uploading the agent and writing inventory must never
  // happen when pct create itself fails.
  assert.equal(goBuilder.built.length, 0);
  assert.equal(ssh.putFileHistory.length, 0);

  const saved = loadInventory(invPath);
  assert.equal(saved.guests.length, 0);
  assert.equal(
    saved.guests.find((g) => g.name === 'nordvpn-gateway-lxc'),
    undefined
  );
});

test('runDeployVpnGateway apply succeeds even when the SSH-key push fails (warn-only, not a hard failure)', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const ssh = new FakeSSHClient((_t, _u, c) => {
    if (c === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAAC3Nz... user@pve1\n', stderr: '', code: 0 };
    }
    // buildAuthorizedKeysWriteScript's follow-up pct exec call writes to
    // /root/.ssh/authorized_keys inside the new guest -- distinct from the
    // provisioning script (which never touches that path) and from
    // pct create, so matching on this substring isolates just the key push.
    if (c.includes('/root/.ssh/authorized_keys')) {
      return { stdout: '', stderr: 'pct exec failed: guest not ready', code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const goBuilder = new FakeGoBuilder();
  const invPath = tempInventoryPath(inventory);

  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
    { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder, fetchImpl: fakeFetch() }
  );

  assert.equal(result.applied, true);

  // Confirm the key-push call actually happened (and thus actually failed)
  // rather than this test passing vacuously because hostKeys was undefined.
  assert.ok(ssh.history.some((c) => c.command.includes('/root/.ssh/authorized_keys')));

  const saved = loadInventory(invPath);
  const gateway = saved.guests.find((g) => g.name === 'nordvpn-gateway-lxc');
  assert.equal(gateway?.vpnGateway, 'nordvpn');
  assert.equal(gateway?.vmid, 4015);
});

test('runDeployVpnGateway throws when PIA_USERNAME/PIA_PASSWORD are unset', async () => {
  delete process.env.PIA_USERNAME;
  delete process.env.PIA_PASSWORD;
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () =>
      runDeployVpnGateway(
        { host: 'pve1', mid: 16, name: 'pia-gateway-lxc', vpn: 'pia' },
        { ssh, inventory, inventoryPath: tempInventoryPath(inventory), goBuilder: new FakeGoBuilder(), fetchImpl: fakePiaFetch() }
      ),
    /PIA username\/password are not set -- fill in the Username\/Password fields on the Deploy VPN Gateway form, or set PIA_USERNAME\/PIA_PASSWORD for CLI use/
  );
});

test('buildCredentialsEnv writes PIA_USERNAME/PIA_PASSWORD/VPN_PROVIDER=pia/GATEWAY_LAN_IP for pia', () => {
  const content = buildCredentialsEnv({ vpn: 'pia', piaUsername: 'p0123456', piaPassword: 'hunter2', gatewayLanIp: '192.168.1.16' });
  assert.equal(content, 'PIA_USERNAME=p0123456\nPIA_PASSWORD=hunter2\nVPN_PROVIDER=pia\nGATEWAY_LAN_IP=192.168.1.16');
});

test('buildCredentialsEnv rejects a PIA username/password containing a newline', () => {
  // A newline would inject an extra line into /etc/vpn-gateway/credentials.env
  // regardless of any escaping, corrupting the env file systemd's
  // EnvironmentFile= directive reads -- this is rejected outright rather
  // than mangled silently.
  assert.throws(
    () => buildCredentialsEnv({ vpn: 'pia', piaUsername: 'p0123456\nEVIL=1', piaPassword: 'hunter2', gatewayLanIp: '192.168.1.16' }),
    /PIA_USERNAME\/PIA_PASSWORD must not contain newlines/
  );
  assert.throws(
    () => buildCredentialsEnv({ vpn: 'pia', piaUsername: 'p0123456', piaPassword: 'hunter2\nEVIL=1', gatewayLanIp: '192.168.1.16' }),
    /PIA_USERNAME\/PIA_PASSWORD must not contain newlines/
  );
});

test('runDeployVpnGateway apply creates a pia-gateway-lxc and records vpnGateway: pia in inventory', async () => {
  process.env.PIA_USERNAME = 'p0123456';
  process.env.PIA_PASSWORD = 'hunter2';
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const goBuilder = new FakeGoBuilder();
  const invPath = tempInventoryPath(inventory);

  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 16, name: 'pia-gateway-lxc', vpn: 'pia', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
    { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder, fetchImpl: fakePiaFetch() }
  );

  assert.equal(result.applied, true);
  assert.equal(result.previewServer.hostname, 'atlanta123');
  assert.equal(result.previewServer.country, 'US Atlanta');

  const provisionCall = ssh.history.find((c) => c.command.includes('PIA_USERNAME=p0123456'));
  assert.ok(provisionCall, 'expected the provisioning script to include PIA_USERNAME');
  assert.ok(provisionCall!.command.includes('PIA_PASSWORD=hunter2'));
  assert.ok(provisionCall!.command.includes('VPN_PROVIDER=pia'));
  assert.ok(provisionCall!.command.includes('GATEWAY_LAN_IP=192.168.1.16'));

  const saved = loadInventory(invPath);
  const gateway = saved.guests.find((g) => g.name === 'pia-gateway-lxc');
  assert.equal(gateway?.vpnGateway, 'pia');
  assert.equal(gateway?.vmid, 4016);
  assert.equal(gateway?.ip, '192.168.1.16');
});

// Issue #16: deploy-vpn-gateway runs for minutes (pct create, agent build and
// upload, connectivity poll) and in the MCP process nothing refreshes
// inventory mid-job. A setting written to disk by another process while that
// remote work runs must survive the command's final inventory save.
test('runDeployVpnGateway apply preserves a setting written to disk while the remote work was running', async () => {
  process.env.NORDVPN_ACCESS_TOKEN = 'my-token';
  const invPath = tempInventoryPath(inventory);
  let written = false;
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (!written && cmd.includes('pct create')) {
      written = true;
      saveInventory(invPath, { ...loadInventory(invPath), dnsServer: '10.0.0.53' });
    }
    return { stdout: '', stderr: '', code: 0 };
  });

  const result = await runDeployVpnGateway(
    { host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', apply: true, connectPollAttempts: 1, connectPollDelayMs: 0 },
    { ssh, inventory: { ...inventory, guests: [] }, inventoryPath: invPath, goBuilder: new FakeGoBuilder(), fetchImpl: fakeFetch() }
  );
  assert.equal(result.applied, true);
  assert.ok(written, 'the concurrent write hook must have fired');

  const reloaded = loadInventory(invPath);
  assert.equal(reloaded.dnsServer, '10.0.0.53', 'a concurrently-written setting must not be reverted');
  assert.ok(reloaded.guests.some((g) => g.name === 'nordvpn-gateway-lxc'));
});
