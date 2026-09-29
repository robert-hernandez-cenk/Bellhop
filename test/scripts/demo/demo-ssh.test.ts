import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoSSHClient } from '../../../scripts/demo/demo-ssh.ts';
import { buildDemoInventory } from '../../../scripts/demo/demo-inventory.ts';

function pve1Target(inv = buildDemoInventory()) {
  const host = inv.hosts.find((h) => h.name === 'pve1')!;
  return { host: host.ssh_target, user: host.ssh_user };
}

function pve2Target(inv = buildDemoInventory()) {
  const host = inv.hosts.find((h) => h.name === 'pve2')!;
  return { host: host.ssh_target, user: host.ssh_user };
}

test('lxc listing on pve1 returns only pve1 lxc guests, each with a fixed running/stopped status', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const result = await client.exec(pve1Target(inv), 'pvesh get /nodes/$(hostname)/lxc --output-format json');
  assert.equal(result.code, 0);
  const entries = JSON.parse(result.stdout) as { vmid: number; name: string; status: string }[];

  const expectedNames = inv.guests
    .filter((g) => g.host === 'pve1' && g.type === 'lxc')
    .map((g) => g.name)
    .sort();
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    expectedNames
  );
  for (const entry of entries) {
    assert.ok(entry.status === 'running' || entry.status === 'stopped', `unexpected status '${entry.status}'`);
  }

  // No pve2 guest should ever appear in pve1's own listing.
  const pve2Names = new Set(inv.guests.filter((g) => g.host === 'pve2').map((g) => g.name));
  for (const entry of entries) {
    assert.ok(!pve2Names.has(entry.name), `pve1 listing leaked pve2 guest '${entry.name}'`);
  }
});

test('qemu listing on pve2 returns only pve2 vm guests', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const result = await client.exec(pve2Target(inv), 'pvesh get /nodes/$(hostname)/qemu --output-format json');
  assert.equal(result.code, 0);
  const entries = JSON.parse(result.stdout) as { vmid: number; name: string; status: string }[];
  const expectedNames = inv.guests
    .filter((g) => g.host === 'pve2' && g.type === 'vm')
    .map((g) => g.name)
    .sort();
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    expectedNames
  );
});

test('pct status/qm status for a free vmid exits non-zero', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const result = await client.exec(
    pve1Target(inv),
    'pct status 1050 >/dev/null 2>&1 || qm status 1050 >/dev/null 2>&1'
  );
  assert.notEqual(result.code, 0);
});

test('an unrecognized command exits 0 with a [demo] simulated: line naming its first line', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const result = await client.exec(pve1Target(inv), 'some totally unknown command\nwith a second line');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[demo] simulated: some totally unknown command');
});

test('a command wrapped for qm guest exec is answered in the JSON envelope runRemote parses', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const demoVm = inv.guests.find((g) => g.name === 'demo-vm')!;
  const result = await client.exec(
    pve2Target(inv),
    `qm guest exec ${demoVm.vmid} --timeout 60 -- sh -c 'echo hi'`
  );
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.stdout) as { exitcode: number; 'out-data': string; 'err-data': string };
  assert.equal(envelope.exitcode, 0);
});

test('never throws across a representative sweep of host- and guest-shaped commands', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const commands = [
    'pvesh get /nodes/$(hostname)/lxc --output-format json',
    'pvesh get /nodes/$(hostname)/qemu --output-format json',
    'pvesh get /nodes/$(hostname)/network --output-format json',
    'pvesh get /nodes/$(hostname)/storage --output-format json',
    'pvesh get /nodes/$(hostname)/lxc/1001/config --output-format json',
    'pvesh get /nodes/$(hostname)/qemu/2003/config --output-format json',
    'cat ~/.ssh/authorized_keys 2>/dev/null',
    'pct status 9999 >/dev/null 2>&1 || qm status 9999 >/dev/null 2>&1',
    "pct exec 1001 -- sh -c 'echo hi'",
    "qm guest exec 2003 --timeout 60 -- sh -c 'echo hi'",
    'if command -v apt-get >/dev/null 2>&1; then echo apt\nelse echo unknown\nfi',
    'entirely unrecognized text',
  ];
  for (const target of [pve1Target(inv), pve2Target(inv)]) {
    for (const command of commands) {
      await assert.doesNotReject(client.exec(target, command));
    }
  }
  // execInteractive and putFile must never throw either.
  await assert.doesNotReject(client.execInteractive(pve1Target(inv), 'echo hi'));
  await assert.doesNotReject(client.putFile(pve1Target(inv), '/tmp/x', Buffer.from('x')));
});

test('the package-manager probe reports apt', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const probe = [
    'if command -v apt-get >/dev/null 2>&1; then echo apt',
    'elif command -v dnf >/dev/null 2>&1; then echo dnf',
    'else echo unknown; fi',
  ].join('\n');
  const result = await client.exec(pve1Target(inv), probe);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'apt');
});

test('authorized_keys returns one clearly truncated placeholder key', async () => {
  const inv = buildDemoInventory();
  const client = new DemoSSHClient(inv);
  const result = await client.exec(pve1Target(inv), 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.equal(result.code, 0);
  assert.ok(result.stdout.trim().length > 0);
  assert.match(result.stdout, /truncated/);
});
