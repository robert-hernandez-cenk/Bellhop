import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shellQuote,
  InteractiveCancelledError,
  resolveIdentityPath,
  resolvePrivateKey,
} from '../../src/lib/ssh-client.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

test('shellQuote wraps a plain value in single quotes', () => {
  assert.equal(shellQuote('hello'), "'hello'");
});

test('shellQuote escapes embedded single quotes safely', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('FakeSSHClient records calls and returns the configured response', async () => {
  const client = new FakeSSHClient((target, user, cmd) => ({
    stdout: `ran ${cmd} as ${user}@${target}`,
    stderr: '',
    code: 0,
  }));
  const result = await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
  assert.equal(result.stdout, 'ran echo hi as root@pve1.local');
  assert.equal(client.history.length, 1);
  assert.deepEqual(client.history[0], { sshTarget: 'pve1.local', sshUser: 'root', command: 'echo hi' });
});

test('FakeSSHClient propagates a responder that throws as a rejected promise', async () => {
  const client = new FakeSSHClient(() => {
    throw new Error('connection refused');
  });
  await assert.rejects(() => client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi'), /connection refused/);
});

test('FakeSSHClient invokes onChunk once with the full stdout/stderr when provided', async () => {
  const client = new FakeSSHClient(() => ({ stdout: 'out-data', stderr: 'err-data', code: 0 }));
  const chunks: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
  await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi', (chunk, stream) => chunks.push({ text: chunk, stream }));
  assert.deepEqual(chunks, [
    { text: 'out-data', stream: 'stdout' },
    { text: 'err-data', stream: 'stderr' },
  ]);
});

test('FakeSSHClient works with no onChunk argument (backward compatible)', async () => {
  const client = new FakeSSHClient(() => ({ stdout: 'x', stderr: '', code: 0 }));
  const result = await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
  assert.equal(result.stdout, 'x');
});

test('FakeSSHClient records putFile uploads separately from exec calls', async () => {
  const client = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]); // ELF magic -- a binary, not text
  await client.putFile({ host: 'pve1.local', user: 'root' }, '/tmp/agent.bin', content);
  await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');

  assert.equal(client.putFileHistory.length, 1);
  assert.equal(client.putFileHistory[0].sshTarget, 'pve1.local');
  assert.equal(client.putFileHistory[0].sshUser, 'root');
  assert.equal(client.putFileHistory[0].remotePath, '/tmp/agent.bin');
  assert.ok(client.putFileHistory[0].content.equals(content), 'the uploaded bytes should be recorded verbatim');
  // An upload is not an exec: it must not show up in the command history
  // that command tests assert exact call sequences against.
  assert.deepEqual(
    client.history.map((c) => c.command),
    ['echo hi']
  );
});

test('FakeSSHClient rejects immediately, without recording a call, when the signal is already aborted', async () => {
  const client = new FakeSSHClient(() => ({ stdout: 'x', stderr: '', code: 0 }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi', undefined, controller.signal),
    /Job cancelled/
  );
  assert.equal(client.history.length, 0);
});

test('FakeSSHClient.execInteractive delegates to the same responder as exec and records interactive:true', async () => {
  const client = new FakeSSHClient((target, user, cmd) => ({
    stdout: `ran ${cmd} as ${user}@${target}`,
    stderr: '',
    code: 0,
  }));
  const result = await client.execInteractive({ host: 'pve1.local', user: 'root' }, 'echo hi');
  assert.equal(result.stdout, 'ran echo hi as root@pve1.local');
  assert.equal(client.history.length, 1);
  assert.deepEqual(client.history[0], {
    sshTarget: 'pve1.local',
    sshUser: 'root',
    command: 'echo hi',
    interactive: true,
  });
});

test('FakeSSHClient.exec calls are still recorded without an interactive field (regression)', async () => {
  const client = new FakeSSHClient(() => ({ stdout: 'x', stderr: '', code: 0 }));
  await client.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
  assert.deepEqual(client.history[0], { sshTarget: 'pve1.local', sshUser: 'root', command: 'echo hi' });
});

test('InteractiveCancelledError has a name distinguishing it from a generic Error', () => {
  const err = new InteractiveCancelledError();
  assert.equal(err.name, 'InteractiveCancelledError');
  assert.ok(err instanceof Error);
});

// A fake home directory with a .ssh/ containing one key, for the path- and
// key-resolution tests below. Passing `home` explicitly is what lets these
// run without touching the real ~/.ssh or mutating HOME/USERPROFILE.
function fakeHome(keys: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'ssh-home-'));
  mkdirSync(join(home, '.ssh'));
  for (const [name, contents] of Object.entries(keys)) {
    writeFileSync(join(home, '.ssh', name), contents);
  }
  return home;
}

test('resolveIdentityPath treats a bare filename as relative to <home>/.ssh', () => {
  const home = fakeHome();
  assert.equal(resolveIdentityPath('pve_key', home), join(home, '.ssh', 'pve_key'));
});

test('resolveIdentityPath expands a leading ~ to the home directory', () => {
  const home = fakeHome();
  assert.equal(resolveIdentityPath('~/.ssh/pve_key', home), join(home, '.ssh', 'pve_key'));
});

test('resolveIdentityPath expands a bare ~ (no trailing separator) to the home directory itself', () => {
  const home = fakeHome();
  assert.equal(resolveIdentityPath('~', home), home);
});

test('resolveIdentityPath expands ~ before applying the bare-filename rule', () => {
  // Rule 1 (~ expansion) wins over rule 2 (bare filename) for a ~-prefixed
  // path that also contains separators -- ~/keys/pve must NOT land under
  // <home>/.ssh/.
  const home = fakeHome();
  assert.equal(resolveIdentityPath('~/keys/pve', home), join(home, 'keys', 'pve'));
});

test('resolveIdentityPath leaves a separator-bearing path as an ordinary path', () => {
  const home = fakeHome();
  const absolute = join(tmpdir(), 'keys', 'pve');
  assert.equal(resolveIdentityPath(absolute, home), absolute);
  // A relative path with a separator resolves against cwd, not <home>/.ssh.
  assert.equal(resolveIdentityPath('./keys/pve', home), join(process.cwd(), 'keys', 'pve'));
});

test('resolvePrivateKey reads the key named by identityFile', () => {
  const home = fakeHome({ pve_key: 'PVE-KEY-BYTES' });
  const key = resolvePrivateKey({ host: 'pve1.local', user: 'root', identityFile: 'pve_key' }, home);
  assert.equal(key?.toString(), 'PVE-KEY-BYTES');
});

test('resolvePrivateKey throws naming the host and resolved path when identityFile is missing', () => {
  const home = fakeHome();
  assert.throws(
    () => resolvePrivateKey({ host: 'pve1.local', user: 'root', identityFile: 'nope_key' }, home),
    (err: Error) => {
      assert.match(err.message, /SSH identity file for pve1\.local is unreadable/);
      // The *resolved* path, so a bare filename's ~/.ssh/ expansion is
      // visible in the error rather than just the operator's input.
      assert.ok(err.message.includes(join(home, '.ssh', 'nope_key')), `message should include the resolved path: ${err.message}`);
      return true;
    }
  );
});

test('resolvePrivateKey falls back to the default lookup when identityFile is unset', () => {
  const home = fakeHome({ id_ed25519: 'DEFAULT-ED25519' });
  const key = resolvePrivateKey({ host: 'pve1.local', user: 'root' }, home);
  assert.equal(key?.toString(), 'DEFAULT-ED25519');
});

test('resolvePrivateKey prefers id_ed25519 over id_rsa in the default lookup', () => {
  const home = fakeHome({ id_ed25519: 'ED', id_rsa: 'RSA' });
  assert.equal(resolvePrivateKey({ host: 'pve1.local', user: 'root' }, home)?.toString(), 'ED');
});

test('resolvePrivateKey returns undefined when no identityFile is set and no default key exists', () => {
  // undefined is the agent-fallback signal -- connectConfig() reads it as
  // "use Pageant/SSH_AUTH_SOCK instead of a privateKey".
  const home = fakeHome();
  assert.equal(resolvePrivateKey({ host: 'pve1.local', user: 'root' }, home), undefined);
});
