import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runConfigureGuest } from '../../src/commands/provisioning/configure-guest.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
};

test('runConfigureGuest requires at least one of --packages or --ssh-key', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runConfigureGuest({ guest: 'media' }, { ssh, inventory }), /Specify at least one/);
});

test('runConfigureGuest rejects an unknown guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'nope', packages: 'curl' }, { ssh, inventory }),
    /Unknown inventory entry: nope/
  );
});

// Detection now runs before confirmOrDryRun (so the dry-run preview can name
// the exact command apply would send -- see US2), so a --packages dry run
// makes one remote call, the probe, rather than zero. The exact preview text
// this produces is asserted separately once US2 lands.
test('runConfigureGuest makes only the probe call in dry run, never the install', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apt\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  await runConfigureGuest({ guest: 'media', packages: 'curl vim' }, { ssh, inventory });
  assert.equal(ssh.history.length, 1, 'probe only');
  assert.match(ssh.history[0].command, /command -v apt-get/);
});

test('runConfigureGuest installs quoted packages and adds an SSH key when apply is set', async () => {
  // Detection now runs first (a probe call), so the responder must answer
  // it -- see test/commands/update-all.test.ts's own responder pattern.
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apt\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  await runConfigureGuest(
    { guest: 'media', packages: 'curl vim', sshKey: 'ssh-ed25519 AAAA test', apply: true },
    { ssh, inventory }
  );
  assert.equal(ssh.history.length, 3, 'probe, install, ssh-key');
  assert.match(ssh.history[0].command, /command -v apt-get/);
  assert.match(ssh.history[1].command, /apt-get install -y/);
  assert.match(ssh.history[1].command, /curl/);
  assert.match(ssh.history[1].command, /vim/);
  // The sshKey command's internal shape changed (now an idempotent
  // mkdir/touch/heredoc-loop via buildAuthorizedKeysEnsurePresentScript,
  // wrapped in pct exec ... sh -c by runRemote's own lxc dispatch since
  // 'media' is an lxc guest), but the raw key text still appears verbatim
  // inside it either way, so these assertions still hold.
  assert.match(ssh.history[2].command, /authorized_keys/);
  assert.match(ssh.history[2].command, /ssh-ed25519 AAAA test/);
});

const NON_APT_MANAGERS: Array<{ pm: string; probeOutput: string; installMatch: RegExp }> = [
  { pm: 'dnf', probeOutput: 'dnf\n', installMatch: /dnf -y install/ },
  { pm: 'apk', probeOutput: 'apk\n', installMatch: /apk update && apk add/ },
  { pm: 'pacman', probeOutput: 'pacman\n', installMatch: /pacman -Syu --needed --noconfirm/ },
  {
    pm: 'zypper',
    probeOutput: 'zypper\n',
    installMatch: /zypper --non-interactive --gpg-auto-import-keys install/,
  },
];

for (const { pm, probeOutput, installMatch } of NON_APT_MANAGERS) {
  test(`runConfigureGuest installs with ${pm}'s own command and never sends apt-get`, async () => {
    const ssh = new FakeSSHClient((_target, _user, cmd) => {
      if (cmd.includes('command -v apt-get')) return { stdout: probeOutput, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    await runConfigureGuest({ guest: 'media', packages: 'curl vim', apply: true }, { ssh, inventory });
    assert.equal(ssh.history.length, 2, 'probe, install');
    assert.match(ssh.history[1].command, installMatch);
    assert.match(ssh.history[1].command, /curl/);
    assert.match(ssh.history[1].command, /vim/);
    assert.doesNotMatch(ssh.history[1].command, /apt-get/);
  });
}

test('runConfigureGuest keeps a package name with a shell metacharacter as one quoted argument', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apt\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  await runConfigureGuest({ guest: 'media', packages: 'a;b', apply: true }, { ssh, inventory });
  assert.match(ssh.history[1].command, /'a;b'/);
});

test("runConfigureGuest's ssh-key command is idempotent (guards each line with grep -qxF before appending)", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest({ guest: 'media', sshKey: 'ssh-ed25519 AAAA test', apply: true }, { ssh, inventory });
  assert.equal(ssh.history.length, 1);
  assert.match(ssh.history[0].command, /grep -qxF/);
});
