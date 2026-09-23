import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { interpretCurlExitCode, probeInsecureBackendTls } from '../../src/lib/tls-probe.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
  guests: [],
};

test('interpretCurlExitCode maps 60 to insecure', () => {
  assert.equal(interpretCurlExitCode(60), 'insecure');
});

test('interpretCurlExitCode maps 51 to insecure', () => {
  assert.equal(interpretCurlExitCode(51), 'insecure');
});

test('interpretCurlExitCode maps 0 to trusted', () => {
  assert.equal(interpretCurlExitCode(0), 'trusted');
});

test('interpretCurlExitCode maps 35 (no TLS at all) to trusted', () => {
  assert.equal(interpretCurlExitCode(35), 'trusted');
});

test('interpretCurlExitCode maps any other code to inconclusive', () => {
  assert.equal(interpretCurlExitCode(7), 'inconclusive');
  assert.equal(interpretCurlExitCode(28), 'inconclusive');
});

test('probeInsecureBackendTls runs curl against the guest ip:port from its parent host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 60 }));
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443);
  assert.equal(result, 'insecure');
  assert.deepEqual(ssh.history[0], {
    sshTarget: 'pve1.local',
    sshUser: 'root',
    command: 'curl -s -o /dev/null --max-time 5 https://192.168.1.9:9443/',
  });
});

test('probeInsecureBackendTls with no opts makes exactly one attempt and returns inconclusive on failure', async () => {
  let calls = 0;
  const ssh = new FakeSSHClient(() => {
    calls++;
    return { stdout: '', stderr: '', code: 7 };
  });
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443);
  assert.equal(result, 'inconclusive');
  assert.equal(calls, 1);
});

test('probeInsecureBackendTls retries an inconclusive result up to the given budget, sleeping between attempts', async () => {
  let calls = 0;
  const ssh = new FakeSSHClient(() => {
    calls++;
    return { stdout: '', stderr: '', code: 7 };
  });
  const sleeps: number[] = [];
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443, {
    retries: 3,
    intervalMs: 1000,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, 'inconclusive');
  assert.equal(calls, 4, 'one initial attempt plus 3 retries');
  assert.deepEqual(sleeps, [1000, 1000, 1000], 'sleeps only between attempts, never after the last one');
});

test('probeInsecureBackendTls short-circuits on the first conclusive result without exhausting retries', async () => {
  let calls = 0;
  const ssh = new FakeSSHClient(() => {
    calls++;
    return calls === 1 ? { stdout: '', stderr: '', code: 7 } : { stdout: '', stderr: '', code: 60 };
  });
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443, {
    retries: 5,
    intervalMs: 1000,
    sleepFn: async () => {},
  });
  assert.equal(result, 'insecure');
  assert.equal(calls, 2, 'must stop retrying once a conclusive result comes back');
});

test('probeInsecureBackendTls treats a thrown SSH error as inconclusive rather than propagating it', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('connection refused');
  });
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443);
  assert.equal(result, 'inconclusive');
});

test('probeInsecureBackendTls stops retrying immediately on a thrown error, never consuming the retry budget', async () => {
  let calls = 0;
  const ssh = new FakeSSHClient(() => {
    calls++;
    throw new Error('connection refused');
  });
  const sleeps: number[] = [];
  const result = await probeInsecureBackendTls(ssh, inventory, 'pve1', '192.168.1.9', 9443, {
    retries: 5,
    intervalMs: 1000,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      throw new Error('sleepFn should never be called after a thrown SSH error');
    },
  });
  assert.equal(result, 'inconclusive');
  assert.equal(calls, 1, 'a thrown error must stop the loop on the very first attempt');
  assert.deepEqual(sleeps, [], 'must never sleep/retry after a thrown error');
});
