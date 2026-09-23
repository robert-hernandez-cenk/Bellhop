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

test('runConfigureGuest does not call ssh in dry run', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest({ guest: 'media', packages: 'curl vim' }, { ssh, inventory });
  assert.equal(ssh.history.length, 0);
});

test('runConfigureGuest installs quoted packages and adds an SSH key when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest(
    { guest: 'media', packages: 'curl vim', sshKey: 'ssh-ed25519 AAAA test', apply: true },
    { ssh, inventory }
  );
  assert.equal(ssh.history.length, 2);
  assert.match(ssh.history[0].command, /apt-get install -y/);
  assert.match(ssh.history[0].command, /curl/);
  assert.match(ssh.history[0].command, /vim/);
  // The sshKey command's internal shape changed (now an idempotent
  // mkdir/touch/heredoc-loop via buildAuthorizedKeysEnsurePresentScript,
  // wrapped in pct exec ... sh -c by runRemote's own lxc dispatch since
  // 'media' is an lxc guest), but the raw key text still appears verbatim
  // inside it either way, so these assertions still hold.
  assert.match(ssh.history[1].command, /authorized_keys/);
  assert.match(ssh.history[1].command, /ssh-ed25519 AAAA test/);
});

test("runConfigureGuest's ssh-key command is idempotent (guards each line with grep -qxF before appending)", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest({ guest: 'media', sshKey: 'ssh-ed25519 AAAA test', apply: true }, { ssh, inventory });
  assert.equal(ssh.history.length, 1);
  assert.match(ssh.history[0].command, /grep -qxF/);
});
