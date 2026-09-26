import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runConfigureGuest } from '../../src/commands/provisioning/configure-guest.ts';
import { UnknownPackageManagerError } from '../../src/lib/package-manager.ts';
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

// Final fix wave F3: a whitespace-only --packages value is truthy, so
// without this check the command used to probe the guest and then install
// nothing (INSTALL_COMMANDS with an empty quoted-argument list). Blank/
// whitespace-only packages must be treated as not given at all.
test('runConfigureGuest treats a whitespace-only --packages as not given, throwing when --ssh-key is also absent', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: '   ' }, { ssh, inventory }),
    /Specify at least one of --packages or --ssh-key/
  );
  assert.equal(ssh.history.length, 0, 'no probe call for a blank --packages value');
});

test('runConfigureGuest skips the packages step for a whitespace-only --packages when --ssh-key is given', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest(
    { guest: 'media', packages: '  ', sshKey: 'ssh-ed25519 AAAA test', apply: true },
    { ssh, inventory }
  );
  assert.equal(ssh.history.length, 1, 'only the ssh-key command runs -- no probe, no install');
  assert.match(ssh.history[0].command, /authorized_keys/);
});

test('runConfigureGuest rejects an unknown guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'nope', packages: 'curl' }, { ssh, inventory }),
    /Unknown inventory entry: nope/
  );
});

// Detection now runs before confirmOrDryRun (so the dry-run preview can name
// the exact command apply would send, like create-lxc/install-app's own live
// previews -- research R4), so a --packages dry run makes one remote call,
// the probe, rather than zero.
test('runConfigureGuest --packages dry run makes only the probe call and logs the exact install command', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runConfigureGuest({ guest: 'media', packages: 'curl vim' }, { ssh, inventory });
  } finally {
    console.log = originalLog;
  }
  assert.equal(ssh.history.length, 1, 'probe only, no install');
  assert.match(ssh.history[0].command, /command -v apt-get/);
  assert.ok(
    logs.some((l) => l.includes("[DRY RUN] Would install on media (apk): apk update && apk add 'curl' 'vim'")),
    `expected the exact dry-run install line, got: ${JSON.stringify(logs)}`
  );
});

test('runConfigureGuest --ssh-key-only dry run makes zero remote calls', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await runConfigureGuest({ guest: 'media', sshKey: 'ssh-ed25519 AAAA test' }, { ssh, inventory });
  assert.equal(ssh.history.length, 0);
});

// SC-004: the command named in the dry-run preview line must be exactly the
// command apply sends -- not just a matching manager name.
test("runConfigureGuest's dry-run preview command equals the command apply actually sends", async () => {
  const responder = (_target: string, _user: string, cmd: string) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };

  // Targets the 'pve1' host, not the 'media' guest: a pve target's command
  // reaches ssh.exec directly with no pct-exec/sh -c wrapping (see
  // src/lib/targets.ts's runRemote), so the captured history entry is the
  // exact string this command built, letting this test compare it
  // byte-for-byte against the dry-run preview's own text.
  const dryRunLogs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => dryRunLogs.push(msg);
  try {
    await runConfigureGuest({ guest: 'pve1', packages: 'curl vim' }, { ssh: new FakeSSHClient(responder), inventory });
  } finally {
    console.log = originalLog;
  }
  const dryRunLine = dryRunLogs.find((l) => l.includes('Would install on pve1'));
  assert.ok(dryRunLine, `expected a dry-run install line, got: ${JSON.stringify(dryRunLogs)}`);
  const match = dryRunLine!.match(/Would install on pve1 \(apk\): (.+)$/);
  assert.ok(match, `expected the dry-run line to name the command, got: ${dryRunLine}`);
  const dryRunCommand = match![1];

  const applySsh = new FakeSSHClient(responder);
  await runConfigureGuest({ guest: 'pve1', packages: 'curl vim', apply: true }, { ssh: applySsh, inventory });
  assert.equal(applySsh.history[1].command, dryRunCommand);
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

test('runConfigureGuest rejects with UnknownPackageManagerError on an unrecognized OS, and sends no install (dry run)', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'unknown\n', stderr: '', code: 0 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: 'curl' }, { ssh, inventory }),
    (err: unknown) => err instanceof UnknownPackageManagerError
  );
  assert.equal(ssh.history.length, 1, 'probe only -- no install attempted');
});

test('runConfigureGuest rejects with UnknownPackageManagerError on an unrecognized OS, and sends no install (apply)', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'unknown\n', stderr: '', code: 0 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: 'curl', apply: true }, { ssh, inventory }),
    (err: unknown) => err instanceof UnknownPackageManagerError
  );
  assert.equal(ssh.history.length, 1, 'probe only -- no install attempted');
});

test('runConfigureGuest rejects when the package-manager probe exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'sh: not found', code: 127 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: 'curl', apply: true }, { ssh, inventory }),
    /Package-manager probe failed on media \(exit 127\): sh: not found/
  );
});

test('runConfigureGuest rejects when the install command exits non-zero, naming the manager and trimmed stderr', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '  disk full  \n', code: 1 };
  });
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: 'curl', apply: true }, { ssh, inventory }),
    /Package install failed on media \(apk, exit 1\): disk full/
  );
});

test('runConfigureGuest reports "no output" when a failed install has empty stderr', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  });
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', packages: 'curl', apply: true }, { ssh, inventory }),
    /Package install failed on media \(apk, exit 1\): no output/
  );
});

test('runConfigureGuest rejects when the ssh-key step exits non-zero, naming the exit code and trimmed stderr', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '  permission denied  \n', code: 1 }));
  await assert.rejects(
    () => runConfigureGuest({ guest: 'media', sshKey: 'ssh-ed25519 AAAA test', apply: true }, { ssh, inventory }),
    /Adding SSH key on media failed \(exit 1\): permission denied/
  );
});

test('runConfigureGuest with both flags never sends the ssh-key command when the install fails', async () => {
  const ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: 'boom', code: 1 };
  });
  await assert.rejects(
    () =>
      runConfigureGuest(
        { guest: 'media', packages: 'curl', sshKey: 'ssh-ed25519 AAAA test', apply: true },
        { ssh, inventory }
      ),
    /Package install failed/
  );
  assert.equal(ssh.history.length, 2, 'probe and the failed install only -- no ssh-key command sent');
  assert.doesNotMatch(ssh.history.map((c) => c.command).join('\n'), /authorized_keys/);
});
