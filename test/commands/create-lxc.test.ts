import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runCreateLxc, buildCreateLxcCommand } from '../../src/commands/provisioning/create-lxc.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

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

test('buildCreateLxcCommand formats the pct create invocation', () => {
  const cmd = buildCreateLxcCommand(
    { host: 'pve1', mid: 4, hostname: 'media', template: 'local:vztmpl/debian-12.tar.zst' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    'local-lvm'
  );
  assert.equal(
    cmd,
    "pct create 4004 'local:vztmpl/debian-12.tar.zst' --hostname 'media' --cores 1 --memory 512 --rootfs 'local-lvm':8 --net0 name=eth0,bridge='vmbr0',ip='192.168.1.4/16',gw='192.168.3.1' --start 1 && pct exec 4004 -- sh -c 'if command -v apt-get >/dev/null 2>&1; then apt-get purge -y postfix; fi'"
  );
});

test('buildCreateLxcCommand guards the postfix purge so a non-apt template does not fail the whole chain', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateLxc(
    { host: 'pve1', mid: 4, hostname: 'alpine', template: 'local:vztmpl/alpine-3.24-default_20260714_amd64.tar.xz' },
    { ssh, inventory }
  );
  // The purge still runs on Debian/Ubuntu templates (it's what keeps a guest
  // convertible to unprivileged later), but is now a no-op rather than a
  // hard failure anywhere apt-get is absent.
  assert.match(result.command, /if command -v apt-get/);
  assert.match(result.command, /apt-get purge -y postfix/);
});

test('runCreateLxc rejects an unknown host', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCreateLxc({ host: 'nope', mid: 4, hostname: 'media', template: 't' }, { ssh, inventory }),
    /Not a Proxmox host in inventory: nope/
  );
});

test("runCreateLxc resolves the host's authorized_keys as its only ssh call in dry run, and returns the command", async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't' }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(result.command, /^pct create 4004/);
  assert.match(result.command, /--rootfs 'local-lvm':8/, 'auto-picked from the host\'s scanned storages');
});

test('runCreateLxc uses the operator-chosen storage over the auto-picked one', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateLxc(
    { host: 'pve1', mid: 4, hostname: 'media', template: 't', storage: 'nas-proxmox' },
    { ssh, inventory }
  );
  assert.match(result.command, /--rootfs 'nas-proxmox':8/);
});

test('runCreateLxc throws when the host has no active rootdir/images storage scanned', async () => {
  const noStorageInventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't' }, { ssh, inventory: noStorageInventory }),
    /Host 'pve1' has no active storage supporting content type rootdir\/images/
  );
});

test('runCreateLxc runs the command on the host when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(result.mid.vmid, 4004);
  assert.equal(ssh.history.length, 2);
  assert.equal(ssh.history[0].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(ssh.history[1].command, /^pct create 4004/);
  assert.equal(ssh.history[1].sshTarget, 'pve1.local');
});

test('runCreateLxc throws when pct create exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'unable to create CT', code: 1 }));
  await assert.rejects(
    () => runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory }),
    /pct create failed on pve1 \(exit 1\): unable to create CT/
  );
});

test('runCreateLxc rejects nfsStorage without nfsMountPoint', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media' }, { ssh, inventory }),
    /--nfs-storage and --nfs-mount-point must be given together/
  );
});

test('runCreateLxc rejects nfsMountPoint without nfsStorage', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsMountPoint: '/data' }, { ssh, inventory }),
    /--nfs-storage and --nfs-mount-point must be given together/
  );
});

test('runCreateLxc rejects an invalid nfsStorage id', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runCreateLxc(
        { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'bad id', nfsMountPoint: '/data' },
        { ssh, inventory }
      ),
    /--nfs-storage must contain only letters, digits, dots, hyphens, and underscores/
  );
});

test('runCreateLxc rejects a relative nfsMountPoint', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runCreateLxc(
        { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: 'data' },
        { ssh, inventory }
      ),
    /--nfs-mount-point must be an absolute path/
  );
});

test('runCreateLxc includes the NFS attach script in the dry-run command when both are set', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runCreateLxc(
    { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: '/data' },
    { ssh, inventory }
  );
  assert.equal(result.applied, false);
  assert.match(result.command, /pct create 4004/);
  assert.match(result.command, /pct set 4004 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
  assert.match(result.command, /pct reboot 4004/);
});

test('runCreateLxc creates the guest then attaches the NFS mount as sequential remote calls when apply is set', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runCreateLxc(
    { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 4);
  assert.equal(ssh.history[0].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(ssh.history[1].command, /^pvesh get \/storage\/nas-media/);
  assert.match(ssh.history[2].command, /^pct create 4004/);
  assert.match(ssh.history[3].command, /pct set 4004 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
});

test('runCreateLxc runs authorized_keys resolution, NFS storage resolution, pct create, the key-append call, then the NFS attach, in that order, when both keys and NFS options are used together', async () => {
  // The existing NFS+apply test above uses a responder that returns empty
  // stdout for everything unmatched, so hostKeys is always empty there and
  // the key-append call never actually happens -- meaning the ordering of
  // keys-vs-NFS calls together has never been asserted anywhere. This
  // covers a host with real authorized_keys AND nfsStorage/nfsMountPoint,
  // apply set, asserting the full 5-call history in order.
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runCreateLxc(
    { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 5);
  assert.equal(ssh.history[0].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(ssh.history[1].command, /^pvesh get \/storage\/nas-media/);
  assert.match(ssh.history[2].command, /^pct create 4004/);
  assert.match(ssh.history[3].command, /^pct exec 4004 -- sh -c/);
  assert.match(ssh.history[3].command, /ssh-ed25519 AAAAKEYCONTENT user@host/);
  assert.match(ssh.history[4].command, /pct set 4004 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
});

test('runCreateLxc surfaces a distinct error when the guest is created but the NFS attach fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    if (cmd.startsWith('pct create')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'mount failed', code: 1 };
  });
  await assert.rejects(
    () =>
      runCreateLxc(
        { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
        { ssh, inventory }
      ),
    /Guest media created successfully \(vmid 4004\), but attaching NFS mount failed: mount failed/
  );
});

test('runCreateLxc does not attempt the NFS attach when pct create itself fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    if (cmd.startsWith('pct create')) {
      return { stdout: '', stderr: 'unable to create CT', code: 1 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () =>
      runCreateLxc(
        { host: 'pve1', mid: 4, hostname: 'media', template: 't', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
        { ssh, inventory }
      ),
    /pct create failed on pve1 \(exit 1\): unable to create CT/
  );
  assert.equal(ssh.history.length, 3, 'authorized_keys resolve + pvesh resolve + failed pct create -- no attach attempted');
});

test('runCreateLxc includes the SSH key append step in the dry-run command when the host has authorized_keys', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 }));
  const result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't' }, { ssh, inventory });
  assert.match(result.command, /pct create 4004/);
  // Not `/pct exec 4004 -- sh -c/` -- the guarded postfix purge (see
  // buildCreateLxcCommand) now also emits that same wrapper unconditionally,
  // so it would pass even if the SSH-key append step were dropped entirely.
  // `mkdir -p /root/.ssh` is unique to buildAuthorizedKeysWriteScript.
  assert.match(result.command, /mkdir -p \/root\/.ssh/);
  assert.match(result.command, /ssh-ed25519 AAAAKEYCONTENT user@host/);
});

test('runCreateLxc omits the SSH key append step when the host has no authorized_keys, but leaves a skip comment in its place', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't' }, { ssh, inventory });
  // The append script itself (the pct exec call that would write keys) must
  // be absent -- but a skip comment mentioning authorized_keys is now
  // expected here (see Fix 5: create-lxc's dry-run preview should never
  // silently omit the SSH-keys step the way it used to), so this asserts
  // on the absence of mkdir/chmod/printf rather than the pct exec call
  // itself (which is now present for the postfix purge guard). The skip
  // comment is the thing that distinguishes "no keys, so skipped" from "keys
  // present, so appended as a separate section".
  assert.doesNotMatch(result.command, /mkdir -p \/root\/.ssh/);
  assert.doesNotMatch(result.command, /# --- provision operator SSH keys/);
  assert.match(result.command, /# --- SSH keys: no authorized_keys found on pve1, skipping ---/);
});

test('runCreateLxc runs the SSH key append as a second sequential call when apply is set and the host has keys', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 }));
  const result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 3);
  assert.equal(ssh.history[0].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(ssh.history[1].command, /^pct create 4004/);
  assert.match(ssh.history[2].command, /^pct exec 4004 -- sh -c/);
  assert.match(ssh.history[2].command, /ssh-ed25519 AAAAKEYCONTENT user@host/);
});

test('runCreateLxc logs a sample ssh connect command after a successful apply', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some((l) => l.includes('Connect with: ssh root@192.168.1.4')));
});

test('runCreateLxc warns but still succeeds when the SSH key append call fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pct create')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'permission denied', code: 1 };
  });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(msg);
  let result;
  try {
    result = await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory });
  } finally {
    console.error = originalError;
  }
  assert.equal(result.applied, true);
  assert.ok(errors.some((l) => l.includes('provisioning SSH keys failed') && l.includes('permission denied')));
});

test('runCreateLxc warns when the host has no authorized_keys to provision', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    await runCreateLxc({ host: 'pve1', mid: 4, hostname: 'media', template: 't', apply: true }, { ssh, inventory });
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((l) => l.includes("No authorized_keys found on host 'pve1'")));
});
