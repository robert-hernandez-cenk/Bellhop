import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory, HostEntry } from '../../src/lib/inventory.ts';
import { resolveTarget, runRemote, selectTargets, resolveMid, stripCidr, checkVmidAvailable, hostSshTarget } from '../../src/lib/targets.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
    { name: 'windows-test', type: 'vm', vmid: 201, host: 'pve2' },
  ],
};

test('resolveTarget resolves a pve host', () => {
  const target = resolveTarget(inventory, 'pve1');
  assert.equal(target.kind, 'pve');
});

test('resolveTarget resolves an lxc guest with its parent host', () => {
  const target = resolveTarget(inventory, 'media');
  assert.equal(target.kind, 'lxc');
  assert.equal(target.parentHost.name, 'pve1');
});

test('resolveTarget throws on an unknown name', () => {
  assert.throws(() => resolveTarget(inventory, 'nope'), /Unknown inventory entry: nope/);
});

test('runRemote sends the command directly to a pve host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'ok', stderr: '', code: 0 }));
  const result = await runRemote(ssh, inventory, 'pve1', 'echo hi');
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(ssh.history[0], { sshTarget: 'pve1.local', sshUser: 'root', command: 'echo hi' });
});

test('runRemote wraps an lxc guest command in pct exec + sh -c', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runRemote(ssh, inventory, 'media', "echo it's fine");
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
  assert.equal(ssh.history[0].command, `pct exec 105 -- sh -c 'echo it'\\''s fine'`);
});

test('runRemote parses a vm guest exec JSON envelope on success', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: JSON.stringify({ exitcode: 0, 'out-data': 'hello\n', 'err-data': '' }),
    stderr: '',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'echo hello');
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.code, 0);
  assert.match(ssh.history[0].command, /^qm guest exec 201 --timeout 60 -- sh -c/);
});

test('runRemote surfaces a vm guest exec non-zero exitcode from the JSON envelope', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: JSON.stringify({ exitcode: 3, 'out-data': '', 'err-data': 'boom' }),
    stderr: '',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'false');
  assert.equal(result.code, 3);
  assert.equal(result.stderr, 'boom');
});

test('runRemote returns the raw failure when ssh/qm itself fails for a vm target', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'Permission denied', code: 255 }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'echo hi');
  assert.equal(result.code, 255);
});

// Final fix wave F1: a command that outlives `qm guest exec`'s --timeout 60
// returns a pid-only envelope with no `exitcode` at all -- the old
// `parsed.exitcode ?? 0` silently reported that as a successful command while
// it was still running in the guest. Captured live 2026-09-26 through
// Ssh2SSHClient.exec on the parent host (pid redacted to 12345, shape
// unchanged): `qm guest exec <vmid> --timeout 2 -- sh -c 'sleep 5; echo done'`.
test('runRemote reports a vm guest exec timeout envelope (pid only, no exitcode) as a failure naming the pid', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: '{\n   "pid" : 12345\n}\n',
    stderr: 'timeout reached, returning pid\n',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', "sleep 5; echo done");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'qm guest exec timed out after 60s; the command is still running in the guest (pid 12345)'
  );
  assert.match(ssh.history[0].command, /--timeout 60 --/);
});

// Captured live 2026-09-26: `qm guest exec <vmid> --timeout 60 -- sh -c
// 'echo ok; exit 3'` -- a normal completed-with-nonzero-exit envelope. Real
// `qm guest exec` output is strict JSON: the command's own trailing newline
// in "out-data" is a proper JSON escape (a literal backslash-n, `\\n` in
// this TS source) rather than a raw embedded newline, so a plain
// `JSON.parse` -- no sanitizing pass -- handles it correctly.
test('runRemote parses the captured completed-nonzero-exit envelope verbatim', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: '{\n   "exitcode" : 3,\n   "exited" : 1,\n   "out-data" : "ok\\n"\n}\n',
    stderr: '',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'echo ok; exit 3');
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.stderr, '');
});

// Issue #2 code review R1: a process killed by a signal returns `exited: 1`
// + `signal` and no `exitcode` at all -- a shape distinct from the pid-only
// "still running" timeout envelope above. The old `typeof parsed.exitcode
// !== 'number'` check sent this down the timeout path too, misreporting a
// signal-killed command as still running and dropping its output. Captured
// live 2026-09-26 through Ssh2SSHClient.exec on the parent host: `qm guest
// exec <vmid> --timeout 10 -- sh -c 'echo before; echo oops >&2; kill -9
// $$'`.
test('runRemote reports a vm guest exec signal-killed envelope as a failure with its output, not a timeout', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: '{\n   "err-data" : "oops\\n",\n   "exited" : 1,\n   "out-data" : "before\\n",\n   "signal" : 9\n}\n',
    stderr: '',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', "echo before; echo oops >&2; kill -9 $$");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'before\n');
  assert.equal(result.stderr, 'oops\nkilled by signal 9');
});

test('runRemote reports a signal-killed envelope with no err-data as just "killed by signal N"', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: JSON.stringify({ exited: 1, 'out-data': 'before\n', signal: 9 }),
    stderr: '',
    code: 0,
  }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'kill -9 $$');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'before\n');
  assert.equal(result.stderr, 'killed by signal 9');
});

test('runRemote reports an unparseable vm guest exec envelope as a failure including the trimmed raw stdout', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '  not json at all  ', stderr: '', code: 0 }));
  const result = await runRemote(ssh, inventory, 'windows-test', 'echo hi');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /qm guest exec output could not be parsed as JSON/);
  assert.match(result.stderr, /not json at all/);
});

test('selectTargets --host validates existence', () => {
  assert.deepEqual(selectTargets(inventory, { host: 'media' }), ['media']);
  assert.throws(() => selectTargets(inventory, { host: 'nope' }), /Unknown host\/guest: nope/);
});

test('selectTargets --all returns every host and guest name', () => {
  assert.deepEqual(selectTargets(inventory, { all: true }), ['pve1', 'pve2', 'media', 'windows-test']);
});

test('selectTargets --group filters by type', () => {
  assert.deepEqual(selectTargets(inventory, { group: 'pve' }), ['pve1', 'pve2']);
  assert.deepEqual(selectTargets(inventory, { group: 'lxc' }), ['media']);
  assert.deepEqual(selectTargets(inventory, { group: 'vm' }), ['windows-test']);
});

test('resolveMid derives VMID/IP/gateway from a host midScheme', () => {
  assert.deepEqual(resolveMid(inventory, 'pve1', 4), { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' });
});

test('resolveMid derives VMID/IP/gateway for a second host with a different midScheme', () => {
  assert.deepEqual(resolveMid(inventory, 'pve2', 4), { vmid: 5004, ip: '192.168.2.4/16', gateway: '192.168.3.1' });
});

test('resolveMid honors an explicit cidrSuffix instead of the /16 default', () => {
  const inv: Inventory = {
    ...inventory,
    hosts: [{ name: 'pve3', ssh_target: 'pve3.local', ssh_user: 'root', midScheme: { vmidBase: 6000, ipPrefix: '10.0.0.', cidrSuffix: 24, gateway: '10.0.0.1' } }],
  };
  assert.deepEqual(resolveMid(inv, 'pve3', 4), { vmid: 6004, ip: '10.0.0.4/24', gateway: '10.0.0.1' });
});

test('resolveMid rejects an out-of-range mid', () => {
  assert.throws(() => resolveMid(inventory, 'pve1', 255), /Invalid --mid: 255/);
  assert.throws(() => resolveMid(inventory, 'pve1', 0), /Invalid --mid: 0/);
});

test('resolveMid rejects an unknown host', () => {
  assert.throws(() => resolveMid(inventory, 'pve-missing', 4), /Unknown host: pve-missing/);
});

test('resolveMid rejects a host with no midScheme configured', () => {
  const inv: Inventory = { ...inventory, hosts: [{ name: 'pve3', ssh_target: 'pve3.local', ssh_user: 'root' }] };
  assert.throws(() => resolveMid(inv, 'pve3', 4), /no midScheme configured/);
});

test('stripCidr removes a /NN mask suffix', () => {
  assert.equal(stripCidr('192.168.1.4/16'), '192.168.1.4');
});

test('stripCidr returns a bare IP unchanged', () => {
  assert.equal(stripCidr('192.168.1.4'), '192.168.1.4');
});

test('checkVmidAvailable resolves silently when the vmid is free on that host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 1 }));
  await assert.doesNotReject(() => checkVmidAvailable(ssh, inventory, 'pve1', 4099));
});

test('checkVmidAvailable throws, naming the conflicting guest, when the vmid is already in use', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => checkVmidAvailable(ssh, inventory, 'pve1', 105),
    /VMID 105 on 'pve1' is already in use by 'media'/
  );
});

test('checkVmidAvailable throws generically when the vmid is in use but untracked in inventory', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => checkVmidAvailable(ssh, inventory, 'pve1', 4999),
    /VMID 4999 on 'pve1' is already in use -- choose a different --mid/
  );
});

test('hostSshTarget maps a plain host to host/user with no port or identity file', () => {
  const host: HostEntry = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  // Undefined, not 0 or '' -- connectConfig() spreads `port` in only when
  // truthy, and resolvePrivateKey() branches on identityFile being set.
  assert.deepEqual(hostSshTarget(host), {
    host: 'pve1.local',
    user: 'root',
    port: undefined,
    identityFile: undefined,
  });
});

test('hostSshTarget carries ssh_port and ssh_identity_file through', () => {
  const host: HostEntry = {
    name: 'pve1',
    ssh_target: 'pve1.local',
    ssh_user: 'root',
    ssh_port: 2222,
    ssh_identity_file: 'pve_key',
  };
  assert.deepEqual(hostSshTarget(host), {
    host: 'pve1.local',
    user: 'root',
    port: 2222,
    identityFile: 'pve_key',
  });
});

test('runRemote passes a pve host ssh_port and ssh_identity_file to the client', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', ssh_port: 2222, ssh_identity_file: 'pve_key' }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'ok', stderr: '', code: 0 }));
  await runRemote(ssh, inv, 'pve1', 'echo hi');
  assert.deepEqual(ssh.history[0], {
    sshTarget: 'pve1.local',
    sshUser: 'root',
    command: 'echo hi',
    sshPort: 2222,
    sshIdentityFile: 'pve_key',
  });
});

test('runRemote reaches a guest using its PARENT host ssh_port and ssh_identity_file', async () => {
  // A guest has no SSH login of its own -- it is always reached by SSHing to
  // its parent host and running pct/qm there, so the parent's connection
  // settings are the ones that must apply.
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', ssh_port: 2222, ssh_identity_file: 'pve_key' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'ok', stderr: '', code: 0 }));
  await runRemote(ssh, inv, 'media', 'echo hi');
  assert.equal(ssh.history[0].sshPort, 2222);
  assert.equal(ssh.history[0].sshIdentityFile, 'pve_key');
});

test('runRemote records no sshPort/sshIdentityFile keys for a host with neither set', async () => {
  // The two keys must be absent, not present-and-undefined: the existing
  // assert.deepEqual assertions on history throughout this suite are strict.
  const ssh = new FakeSSHClient(() => ({ stdout: 'ok', stderr: '', code: 0 }));
  await runRemote(ssh, inventory, 'pve1', 'echo hi');
  assert.deepEqual(ssh.history[0], { sshTarget: 'pve1.local', sshUser: 'root', command: 'echo hi' });
});
