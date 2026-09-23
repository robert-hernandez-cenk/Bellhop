import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { readHostAuthorizedKeys, buildAuthorizedKeysWriteScript, buildAuthorizedKeysEnsurePresentScript } from '../../src/lib/authorized-keys.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
  guests: [],
};

test('readHostAuthorizedKeys runs cat against the host and returns the trimmed content', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    assert.equal(cmd, 'cat ~/.ssh/authorized_keys 2>/dev/null');
    return { stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 };
  });
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, 'ssh-ed25519 AAAAKEYCONTENT user@host');
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, 'pve1.local');
});

test('readHostAuthorizedKeys returns undefined when the file is empty', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, undefined);
});

test('readHostAuthorizedKeys returns undefined when the file does not exist (non-zero exit, empty stdout)', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'No such file or directory', code: 1 }));
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, undefined);
});

test('readHostAuthorizedKeys preserves multiple keys (multi-line content) verbatim, just trimmed', async () => {
  const ssh = new FakeSSHClient(() => ({
    stdout: '\nssh-ed25519 KEYONE user@laptop\nssh-ed25519 KEYTWO user@desktop\n\n',
    stderr: '',
    code: 0,
  }));
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, 'ssh-ed25519 KEYONE user@laptop\nssh-ed25519 KEYTWO user@desktop');
});

test('readHostAuthorizedKeys strips embedded \\r characters from pty-translated line endings (issue #57)', async () => {
  // A pty-backed exec translates \n to \r\n (ONLCR terminal mode).
  // Multi-key output with pty: 'key1\r\nkey2\r\n' must be stripped of \r
  // to produce 'key1\nkey2', not 'key1\r\nkey2' (which would corrupt keys
  // when passed to community-scripts' install_ssh_keys_into_ct).
  const ssh = new FakeSSHClient(() => ({
    stdout: 'ssh-ed25519 AAAAKEYCONTENT user@laptop\r\nssh-ed25519 AAAAKEYCONTENT user@desktop\r\n',
    stderr: '',
    code: 0,
  }));
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, 'ssh-ed25519 AAAAKEYCONTENT user@laptop\nssh-ed25519 AAAAKEYCONTENT user@desktop');
  // Verify no embedded \r remains anywhere in the output
  assert.ok(!keys.includes('\r'), 'output must not contain \\r characters');
});

test('readHostAuthorizedKeys resolves to undefined (rather than rejecting) when the SSH transport itself fails', async () => {
  // ssh.exec throwing synchronously is how FakeSSHClient simulates a
  // runRemote/Ssh2SSHClient transport-level rejection (host unreachable,
  // auth failure, ...) -- distinct from the "cat exited non-zero" case
  // above, which resolves normally with an empty stdout. Both must
  // collapse to undefined per this function's doc comment, and in
  // particular this must never reject: create-lxc/install-app's dry-run
  // preview calls this synchronously before a job exists, so a rejection
  // here would surface as a raw, unlogged error instead of a normal
  // dry-run/job failure (see src/web/routes/provisioning.ts's /apply route).
  const ssh = new FakeSSHClient(() => {
    throw new Error('connect ECONNREFUSED');
  });
  const keys = await readHostAuthorizedKeys(ssh, inventory, 'pve1');
  assert.equal(keys, undefined);
});

test('buildAuthorizedKeysWriteScript wraps a pct exec sh -c that prepares and writes /root/.ssh/authorized_keys', () => {
  const script = buildAuthorizedKeysWriteScript(4004, 'ssh-ed25519 AAAAKEYCONTENT user@host');
  assert.match(script, /^pct exec 4004 -- sh -c '/);
  assert.match(script, /mkdir -p \/root\/\.ssh && chmod 700 \/root\/\.ssh/);
  assert.match(script, /ssh-ed25519 AAAAKEYCONTENT user@host/);
  assert.match(script, /> \/root\/\.ssh\/authorized_keys && chmod 600 \/root\/\.ssh\/authorized_keys/);
});

test('buildAuthorizedKeysWriteScript preserves multiple keys as separate lines in the written content', () => {
  const script = buildAuthorizedKeysWriteScript(4004, 'ssh-ed25519 KEYONE user@laptop\nssh-ed25519 KEYTWO user@desktop');
  assert.match(script, /KEYONE/);
  assert.match(script, /KEYTWO/);
});

test('buildAuthorizedKeysWriteScript survives a key comment containing a single quote', () => {
  // The double-shellQuote nesting (once for the printf'd key content, once
  // for the whole `sh -c` payload) is the part most likely to break
  // against a real shell if it regresses, so this asserts the exact
  // expected output byte-for-byte rather than a loose regex. The expected
  // string below was derived by hand-tracing shellQuote's POSIX
  // single-quote-escaping rule (each `'` becomes `'\''`) through both
  // nesting levels, then independently confirmed two ways: (1) a small
  // script computed the same string programmatically from shellQuote's own
  // algorithm, and (2) the generated `pct exec ... sh -c '...'` string
  // was actually run through a real shell (with `pct` faked to just run its
  // trailing `-c` argument, and /root/.ssh redirected to a scratch
  // directory) -- the file it wrote back out matched the original key
  // exactly, including the embedded apostrophe.
  const script = buildAuthorizedKeysWriteScript(4004, "ssh-ed25519 AAAAKEYCONTENT rob's laptop");
  assert.equal(
    script,
    "pct exec 4004 -- sh -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '\\''%s\\n'\\'' '\\''ssh-ed25519 AAAAKEYCONTENT rob'\\''\\'\\'''\\''s laptop'\\'' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'"
  );
});

test('buildAuthorizedKeysEnsurePresentScript wraps mkdir/chmod/touch plus a trailing-newline guard plus an idempotent while-read-append loop', () => {
  const script = buildAuthorizedKeysEnsurePresentScript('ssh-ed25519 AAAAKEYCONTENT user@host');
  assert.match(script, /^mkdir -p \/root\/\.ssh && chmod 700 \/root\/\.ssh$/m);
  assert.match(script, /^touch \/root\/\.ssh\/authorized_keys && chmod 600 \/root\/\.ssh\/authorized_keys$/m);
  assert.match(script, /^if \[ -s \/root\/\.ssh\/authorized_keys \] && \[ -n "\$\(tail -c1 \/root\/\.ssh\/authorized_keys\)" \]; then$/m);
  assert.match(script, /^  printf '\\n' >> \/root\/\.ssh\/authorized_keys$/m);
  assert.match(script, /^fi$/m);
  assert.match(
    script,
    /^while IFS= read -r line; do \[ -z "\$line" \] && continue; grep -qxF "\$line" \/root\/\.ssh\/authorized_keys \|\| printf '%s\\n' "\$line" >> \/root\/\.ssh\/authorized_keys; done <<'BELLHOP_KEYS_EOF'$/m
  );
  assert.match(script, /^ssh-ed25519 AAAAKEYCONTENT user@host$/m);
  assert.match(script, /^BELLHOP_KEYS_EOF$/m);
});

test('buildAuthorizedKeysEnsurePresentScript places the trailing-newline guard between the touch/chmod line and the append loop, so a file missing its final newline gets one before any key is appended', () => {
  // Regression test for a real data-corruption bug (verified against real
  // bash): without this guard, appending to a file that doesn't already
  // end in a newline concatenates the new key directly onto the end of the
  // existing last line, destroying both in one write. This is a structural
  // assertion (can't execute real bash in a unit test), so it checks the
  // guard clause is present and ordered correctly relative to its
  // neighbors rather than executing it.
  const script = buildAuthorizedKeysEnsurePresentScript('ssh-ed25519 AAAANEW user@new');
  const touchIndex = script.indexOf('touch /root/.ssh/authorized_keys');
  const guardIndex = script.indexOf('tail -c1 /root/.ssh/authorized_keys');
  const loopIndex = script.indexOf('while IFS= read -r line');
  assert.ok(touchIndex >= 0 && guardIndex >= 0 && loopIndex >= 0, 'all three sections must be present');
  assert.ok(touchIndex < guardIndex, 'guard must come after touch/chmod');
  assert.ok(guardIndex < loopIndex, 'guard must come before the append loop');
});

test('buildAuthorizedKeysEnsurePresentScript embeds a key containing a single quote completely unescaped -- heredocs need no quoting', () => {
  // Unlike buildAuthorizedKeysWriteScript (which shellQuote's the key content
  // for a printf argument), this function has no escaping to do at all: the
  // key lives inside a quoted heredoc (<<'BELLHOP_KEYS_EOF'), which
  // disables all shell interpretation of its body until the delimiter line.
  // The one shellQuote pass this whole script gets happens later, inside
  // runRemote's own dispatch -- not here. So the embedded apostrophe below
  // must appear byte-for-byte unmodified in the output.
  const script = buildAuthorizedKeysEnsurePresentScript("ssh-ed25519 AAAAKEYCONTENT rob's laptop");
  assert.match(script, /^ssh-ed25519 AAAAKEYCONTENT rob's laptop$/m);
});

test('buildAuthorizedKeysEnsurePresentScript preserves multiple keys as separate heredoc lines', () => {
  const script = buildAuthorizedKeysEnsurePresentScript('ssh-ed25519 KEYONE user@laptop\nssh-ed25519 KEYTWO user@desktop');
  assert.match(script, /^ssh-ed25519 KEYONE user@laptop$/m);
  assert.match(script, /^ssh-ed25519 KEYTWO user@desktop$/m);
});
