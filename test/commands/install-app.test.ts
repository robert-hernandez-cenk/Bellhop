import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import {
  runInstallApp,
  buildInstallAppScript,
  resolveAppUrl,
  resolveDevAppUrl,
  appSlugFor,
  pickStorage,
} from '../../src/commands/provisioning/install-app.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { InteractiveCancelledError, shellQuote } from '../../src/lib/ssh-client.ts';
import { UPSTREAM_STABLE_BASE, UPSTREAM_DEV_BASE, type AppSource } from '../../src/lib/app-source.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      storages: [
        { name: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
      ],
    },
  ],
  guests: [],
};

const storage = { template: 'local', container: 'local-lvm' };

test('buildInstallAppScript sets the community-scripts var_* env vars and curls the installer', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /export var_ctid=4004/);
  assert.match(script, /export var_hostname='plex'/);
  assert.match(script, /export var_net='192.168.1.4\/16'/);
  assert.match(script, /export var_template_storage='local'/);
  assert.match(script, /export var_container_storage='local-lvm'/);
  assert.match(script, /raw\.githubusercontent\.com\/community-scripts\/ProxmoxVE\/main\/ct\/plex\.sh/);
});

test('buildInstallAppScript exports TERM before anything else, so build.func\'s clear call does not abort the install', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.equal(script.split('\n')[0], 'export TERM=xterm');
});

test('buildInstallAppScript exports mode=default and PHS_SILENT=1 to bypass build.func\'s interactive menus', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /^export mode=default$/m);
  assert.match(script, /^export PHS_SILENT=1$/m);
});

test('buildInstallAppScript upserts default.vars with the resolved storage so build.func\'s storage-pool prompt never fires', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /mkdir -p \/usr\/local\/community-scripts/);
  assert.match(script, /^touch \/usr\/local\/community-scripts\/default\.vars$/m);
  // Removes any prior line for both keys before appending -- must not just
  // gate on the file's existence, since build.func's own
  // ensure_global_default_vars_file() can leave a stale *empty* default.vars
  // behind from an earlier hung attempt, which a plain existence check would
  // mistake for "already seeded".
  assert.match(
    script,
    /^sed -i '\/\^\[#\[:space:\]\]\*var_template_storage=\/d;\/\^\[#\[:space:\]\]\*var_container_storage=\/d' \/usr\/local\/community-scripts\/default\.vars$/m
  );
  assert.match(
    script,
    /printf 'var_template_storage=%s\\nvar_container_storage=%s\\n' 'local' 'local-lvm' >> \/usr\/local\/community-scripts\/default\.vars/
  );
});

test('pickStorage picks the first active storage supporting one of the given content types', () => {
  const host = inventory.hosts[0];
  assert.equal(pickStorage(host, ['vztmpl']), 'local');
  assert.equal(pickStorage(host, ['rootdir', 'images']), 'local-lvm');
});

test('pickStorage throws a clear error when no active storage supports the content type', () => {
  const hostWithNoTemplateStorage = {
    name: 'pve2',
    ssh_target: 'pve2.local',
    ssh_user: 'root',
    storages: [{ name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true }],
  };
  assert.throws(
    () => pickStorage(hostWithNoTemplateStorage, ['vztmpl']),
    /Host 'pve2' has no active storage supporting content type vztmpl/
  );
});

test('pickStorage ignores an inactive storage even if it supports the content type', () => {
  const host = {
    name: 'pve2',
    ssh_target: 'pve2.local',
    ssh_user: 'root',
    storages: [{ name: 'old-storage', type: 'dir', content: ['vztmpl'], active: false }],
  };
  assert.throws(() => pickStorage(host, ['vztmpl']), /Host 'pve2' has no active storage/);
});

test('pickStorage throws when the host has no storages scanned at all', () => {
  const host = { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root' };
  assert.throws(
    () => pickStorage(host, ['vztmpl']),
    /Host 'pve2' has no active storage supporting content type vztmpl -- run sync-inventory/
  );
});

test('runInstallApp rejects an invalid app name', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'Plex Media', hostname: 'plex' }, { ssh, inventory }),
    /--app must contain only lowercase letters/
  );
});

test("runInstallApp checks the target vmid is free, then resolves the host's authorized_keys, as its only two ssh calls in dry run, and returns the resolved vmid", async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const result = await runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(result.mid.vmid, 4004);
  assert.equal(ssh.history.length, 2);
  assert.equal(ssh.history[0].command, 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1');
  assert.equal(ssh.history[1].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
});

test('runInstallApp runs the script on the host when apply is set', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const result = await runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 3);
  assert.equal(ssh.history[0].command, 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1');
  assert.equal(ssh.history[1].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.equal(ssh.history[2].sshTarget, 'pve1.local');
  assert.match(ssh.history[2].command, /export var_ctid=4004/);
});

test('runInstallApp throws when the remote script exits non-zero', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'ERROR: something broke', code: 1 }));
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true }, { ssh, inventory }),
    /install-app script failed on pve1 \(exit 1\): ERROR: something broke/
  );
});

test('runInstallApp throws (even in dry run) when the host has no matching storage scanned', async () => {
  const noStorageInventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const ssh = new FakeSSHClient(defaultResponder);
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory: noStorageInventory }),
    /Host 'pve1' has no active storage supporting content type vztmpl/
  );
});

test('runInstallApp throws a clear error when the target vmid is already in use by a known inventory guest', async () => {
  const collidingInventory: Inventory = {
    ...inventory,
    guests: [{ name: 'existing-app-lxc', type: 'lxc', vmid: 4004, host: 'pve1' }],
  };
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1') {
      return { stdout: 'status: running', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory: collidingInventory }),
    /VMID 4004 on 'pve1' is already in use by 'existing-app-lxc' -- choose a different --mid/
  );
});

test('runInstallApp throws a generic collision error when the target vmid is in use but not tracked in inventory', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1') {
      return { stdout: 'status: running', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory }),
    /VMID 4004 on 'pve1' is already in use -- choose a different --mid/
  );
});

test('runInstallApp checks both pct status and qm status for the target vmid, so a same-numbered vm guest is also caught as a collision', async () => {
  const vmCollisionInventory: Inventory = {
    ...inventory,
    guests: [{ name: 'existing-vm', type: 'vm', vmid: 4004, host: 'pve1' }],
  };
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd === 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1') {
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory: vmCollisionInventory }),
    /VMID 4004 on 'pve1' is already in use by 'existing-vm' -- choose a different --mid/
  );
});

test('resolveAppUrl builds the community-scripts URL for a bare slug', () => {
  assert.equal(resolveAppUrl('plex'), 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh');
});

test('resolveAppUrl lowercases a bare slug so casing never makes a valid app look invalid', () => {
  assert.equal(resolveAppUrl('Plex'), 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh');
  assert.equal(resolveAppUrl('HOME-ASSISTANT'), 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/home-assistant.sh');
});

test('resolveAppUrl passes a full URL through unchanged, with no reformatting', () => {
  const url = 'https://example.com/some/Custom-Installer.sh';
  assert.equal(resolveAppUrl(url), url);
});

test('resolveDevAppUrl builds the dev-repo (ProxmoxVED) URL for a bare slug, lowercased the same as resolveAppUrl', () => {
  assert.equal(
    resolveDevAppUrl('budget-board'),
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/budget-board.sh'
  );
  assert.equal(
    resolveDevAppUrl('Budget-Board'),
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/budget-board.sh'
  );
});

test('resolveDevAppUrl has no dev-repo equivalent for a pasted full URL', () => {
  assert.equal(resolveDevAppUrl('https://example.com/some/custom.sh'), undefined);
});

test('appSlugFor lowercases a bare slug', () => {
  assert.equal(appSlugFor('Plex'), 'plex');
  assert.equal(appSlugFor('HOME-ASSISTANT'), 'home-assistant');
});

test('appSlugFor returns undefined for a pasted full URL -- no community-scripts slug to map to a page', () => {
  assert.equal(appSlugFor('https://example.com/some/Custom-Installer.sh'), undefined);
});

test('buildInstallAppScript falls back to the dev-repo URL at curl-time if the main repo 404s', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'budget-board', hostname: 'budget-board' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(
    script,
    /curl -fsSL 'https:\/\/raw\.githubusercontent\.com\/community-scripts\/ProxmoxVE\/main\/ct\/budget-board\.sh' 2>\/dev\/null \|\| curl -fsSL 'https:\/\/raw\.githubusercontent\.com\/community-scripts\/ProxmoxVED\/main\/ct\/budget-board\.sh'/
  );
});

test('buildInstallAppScript has no dev-repo fallback when --app is a pasted full URL', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'https://example.com/custom.sh', hostname: 'custom' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /bash -c "\$\(curl -fsSL 'https:\/\/example\.com\/custom\.sh'\)"/);
  assert.doesNotMatch(script, /ProxmoxVED/);
});

test('buildInstallAppScript curls a pasted full URL directly instead of the community-scripts base', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'https://example.com/custom.sh', hostname: 'custom' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /curl -fsSL 'https:\/\/example\.com\/custom\.sh'/);
  // The community-scripts default.vars pre-seed (see the dedicated test
  // above) still applies here -- it guards against build.func's own
  // storage-pool prompt, which a pasted script sources the same way a bare
  // slug's does, so it's not specific to the community-scripts URL base.
  assert.doesNotMatch(script, /raw\.githubusercontent\.com\/community-scripts/);
});

test('runInstallApp accepts a full URL as --app without the slug-format check rejecting it', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'https://example.com/Custom_Installer.sh', hostname: 'custom' },
    { ssh, inventory }
  );
  assert.equal(result.applied, false);
  assert.match(result.script, /custom_installer\.sh|Custom_Installer\.sh/i);
});

test('runInstallApp rejects nfsStorage without nfsMountPoint', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media' }, { ssh, inventory }),
    /--nfs-storage and --nfs-mount-point must be given together/
  );
});

test('runInstallApp rejects nfsMountPoint without nfsStorage', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () => runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsMountPoint: '/data' }, { ssh, inventory }),
    /--nfs-storage and --nfs-mount-point must be given together/
  );
});

test('runInstallApp rejects an invalid nfsStorage id', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'bad id', nfsMountPoint: '/data' },
        { ssh, inventory }
      ),
    /--nfs-storage must contain only letters, digits, dots, hyphens, and underscores/
  );
});

test('runInstallApp rejects a relative nfsMountPoint', async () => {
  const ssh = new FakeSSHClient(() => {
    throw new Error('should not be called');
  });
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media', nfsMountPoint: 'data' },
        { ssh, inventory }
      ),
    /--nfs-mount-point must be an absolute path/
  );
});

test('runInstallApp includes the NFS attach script in the dry-run script when both are set', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status ')) {
      return { stdout: '', stderr: '', code: 1 };
    }
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media', nfsMountPoint: '/data' },
    { ssh, inventory }
  );
  assert.equal(result.applied, false);
  assert.match(result.script, /export var_ctid=4004/);
  assert.match(result.script, /pct set 4004 -mp0 \/mnt\/pve\/nas-media,mp=\/data/);
  assert.match(result.script, /pct reboot 4004/);
});

test('runInstallApp installs the app then attaches the NFS mount as sequential remote calls when apply is set', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status ')) {
      return { stdout: '', stderr: '', code: 1 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.equal(ssh.history.length, 5);
  assert.equal(ssh.history[0].command, 'pct status 4004 >/dev/null 2>&1 || qm status 4004 >/dev/null 2>&1');
  assert.equal(ssh.history[1].command, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  assert.match(ssh.history[2].command, /^pvesh get \/storage\/nas-media/);
  assert.match(ssh.history[3].command, /export var_ctid=4004/);
  assert.match(ssh.history[4].command, /pct set 4004 -mp0/);
});

test('runInstallApp uses execInteractive for the install script when opts.interactive is set', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true, interactive: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  const installCall = ssh.history.find((c) => c.command.includes('var_ctid'));
  assert.ok(installCall, 'install script call should be recorded');
  assert.equal(installCall!.interactive, true);
  // the vmid pre-check must stay on the plain, buffered exec path
  assert.equal(ssh.history[0].interactive, undefined);
});

test('runInstallApp uses the buffered runRemote path when opts.interactive is unset (regression)', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true },
    { ssh, inventory }
  );
  assert.equal(result.applied, true);
  assert.ok(ssh.history.every((c) => c.interactive === undefined));
});

test('runInstallApp surfaces a partial-guest warning when the interactive install is cancelled locally', async () => {
  class CancellingSSHClient extends FakeSSHClient {
    async execInteractive(): Promise<never> {
      throw new InteractiveCancelledError();
    }
  }
  const ssh = new CancellingSSHClient(defaultResponder);
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true, interactive: true },
        { ssh, inventory }
      ),
    /Install cancelled -- vmid 4004 on pve1 may be left partially created/
  );
});

test('runInstallApp does not re-dump the full interactive install transcript on failure', async () => {
  class FailingInteractiveSSHClient extends FakeSSHClient {
    async execInteractive(): Promise<{ stdout: string; stderr: string; code: number }> {
      return { stdout: 'a very long live-streamed install transcript...', stderr: '', code: 1 };
    }
  }
  const ssh = new FailingInteractiveSSHClient(defaultResponder);
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true, interactive: true },
        { ssh, inventory }
      ),
    /install-app script failed on pve1 \(exit 1\): see the output above/
  );
});

test('runInstallApp surfaces a distinct error when the app installs but the NFS attach fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    if (cmd.includes('var_ctid')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'mount failed', code: 1 };
  });
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
        { ssh, inventory }
      ),
    /Guest plex created successfully \(vmid 4004\), but attaching NFS mount failed: mount failed/
  );
});

test('runInstallApp does not attempt the NFS attach when the install script itself fails', async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status ')) {
      return { stdout: '', stderr: '', code: 1 };
    }
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd.startsWith('pvesh get /storage/nas-media')) {
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-media' }), stderr: '', code: 0 };
    }
    if (cmd.includes('var_ctid')) {
      return { stdout: '', stderr: 'ERROR: something broke', code: 1 };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', nfsStorage: 'nas-media', nfsMountPoint: '/data', apply: true },
        { ssh, inventory }
      ),
    /install-app script failed on pve1 \(exit 1\): ERROR: something broke/
  );
  assert.equal(
    ssh.history.length,
    4,
    'vmid free check + authorized_keys resolve + pvesh resolve + failed install script -- no attach attempted'
  );
});

test('buildInstallAppScript exports var_ssh=yes and var_ssh_authorized_key when hostKeys is given', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage,
    'ssh-ed25519 AAAAKEYCONTENT user@host'
  );
  assert.match(script, /^export var_ssh=yes$/m);
  assert.match(script, /^export var_ssh_authorized_key='ssh-ed25519 AAAAKEYCONTENT user@host'$/m);
});

test('buildInstallAppScript exports var_ssh=no and omits var_ssh_authorized_key when hostKeys is undefined', () => {
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.match(script, /^export var_ssh=no$/m);
  assert.doesNotMatch(script, /var_ssh_authorized_key/);
});

test("runInstallApp resolves the host's authorized_keys and passes them through to the script", async () => {
  const ssh = new FakeSSHClient((_t, _u, cmd) => {
    if (cmd.startsWith('pct status ')) {
      return { stdout: '', stderr: '', code: 1 };
    }
    return { stdout: 'ssh-ed25519 AAAAKEYCONTENT user@host\n', stderr: '', code: 0 };
  });
  const result = await runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' }, { ssh, inventory });
  assert.match(result.script, /^export var_ssh=yes$/m);
  assert.match(result.script, /ssh-ed25519 AAAAKEYCONTENT user@host/);
});

test('runInstallApp logs a sample ssh connect command after a successful apply', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true }, { ssh, inventory });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some((l) => l.includes('Connect with: ssh root@192.168.1.4')));
});

test('runInstallApp warns when the host has no authorized_keys to provision', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    await runInstallApp({ host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', apply: true }, { ssh, inventory });
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((l) => l.includes("No authorized_keys found on host 'pve1'")));
});

// --- custom script repository (issue #11) ---
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model/
// test/lib/app-source.test.ts use.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
function fixtureText(name: string): string {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}
const HEAD_SHA_RAW = fixtureText('branch-head-sha.txt');
const SHA = HEAD_SHA_RAW.trim();

const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const CUSTOM_LABEL = `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`;
const HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
// issue #15: every custom-configured resolution also compares the pinned
// commit against upstream ProxmoxVED main -- the captured ahead fixture
// (8 ahead / 0 behind) changes demo-shop, demo-shop-storefront, demo-books.
const COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${CUSTOM_OWNER}:${CUSTOM_REPO}:${SHA}`;
const COMPARE_AHEAD_BODY = readFileSync(path.join(fixtureDir, 'compare-ahead-3-apps.json'), 'utf8');
const MERGE_BASE = (JSON.parse(COMPARE_AHEAD_BODY) as { merge_base_commit: { sha: string } }).merge_base_commit.sha;
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;
const customScriptsBaseUrl = `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}`;
const shadowUrl = (base: string, slug: string) => `${base}/ct/${slug}.sh`;

const inventoryWithCustomSource: Inventory = {
  ...inventory,
  customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
  customScriptsBranch: CUSTOM_BRANCH,
};

// Routes a full custom-repository resolution: head-SHA lookup, the compare
// call (ahead fixture -- pass one of its changed slugs), and both upstream
// shadow probes (always "not present" -- a plain 404) -- mirrors app-source.test.ts's own
// customFetch, kept local to this file rather than shared/exported since
// each test file in this suite owns its own fixtures.
function customFetch(slug: string): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === shadowUrl(UPSTREAM_STABLE_BASE, slug)) return new Response(null, { status: 404 });
    if (href === shadowUrl(UPSTREAM_DEV_BASE, slug)) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

test('buildInstallAppScript with an upstream (or omitted) source produces byte-identical output to before this feature existed', () => {
  const expected = [
    'export TERM=xterm',
    'export mode=default',
    'export PHS_SILENT=1',
    "export var_hostname='plex'",
    'export var_ctid=4004',
    'export var_cpu=1',
    'export var_ram=512',
    'export var_disk=8',
    "export var_brg='vmbr0'",
    "export var_net='192.168.1.4/16'",
    "export var_gateway='192.168.3.1'",
    "export var_template_storage='local'",
    "export var_container_storage='local-lvm'",
    'export var_ssh=no',
    'mkdir -p /usr/local/community-scripts',
    'touch /usr/local/community-scripts/default.vars',
    "sed -i '/^[#[:space:]]*var_template_storage=/d;/^[#[:space:]]*var_container_storage=/d' /usr/local/community-scripts/default.vars",
    "printf 'var_template_storage=%s\\nvar_container_storage=%s\\n' 'local' 'local-lvm' >> /usr/local/community-scripts/default.vars",
    `bash -c "$(curl -fsSL 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh' 2>/dev/null || curl -fsSL 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/plex.sh')"`,
  ].join('\n');

  const withoutSource = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage
  );
  assert.equal(withoutSource, expected);

  const withUpstreamSource = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage,
    undefined,
    { kind: 'upstream', slug: 'plex', shadows: [] }
  );
  assert.equal(withUpstreamSource, expected);
});

test('buildInstallAppScript exports COMMUNITY_SCRIPTS_URL immediately before the curl line and has no upstream fallback for a custom source', () => {
  const source: AppSource = {
    kind: 'custom',
    slug: 'demo-shop',
    custom: { owner: CUSTOM_OWNER, repo: CUSTOM_REPO, branch: CUSTOM_BRANCH, label: CUSTOM_LABEL, sha: SHA, mergeBase: MERGE_BASE },
    changed: true,
    conflict: false,
    ctUrl: customCtUrl('demo-shop'),
    scriptsBaseUrl: customScriptsBaseUrl,
    shadows: [],
  };
  const script = buildInstallAppScript(
    { host: 'pve1', mid: 4, app: 'demo-shop', hostname: 'demo-shop' },
    { vmid: 4004, ip: '192.168.1.4/16', gateway: '192.168.3.1' },
    storage,
    undefined,
    source
  );
  const lines = script.split('\n');
  const exportLine = `export COMMUNITY_SCRIPTS_URL=${shellQuote(customScriptsBaseUrl)}`;
  const curlLine = `bash -c "$(curl -fsSL ${shellQuote(customCtUrl('demo-shop'))})"`;
  assert.equal(lines[lines.length - 2], exportLine);
  assert.equal(lines[lines.length - 1], curlLine);
  assert.doesNotMatch(script, /\|\|/);
});

test('runInstallApp resolves a custom source via fetchImpl and produces the same script for dry run and apply', async () => {
  const fetchImpl = customFetch('demo-shop');
  const dryRun = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'demo-shop', hostname: 'demo-shop', fetchImpl },
    { ssh: new FakeSSHClient(defaultResponder), inventory: inventoryWithCustomSource }
  );
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.source.kind, 'custom');
  assert.ok(dryRun.script.includes(`export COMMUNITY_SCRIPTS_URL=${shellQuote(customScriptsBaseUrl)}`));

  const applySsh = new FakeSSHClient(defaultResponder);
  const applied = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'demo-shop', hostname: 'demo-shop', apply: true, fetchImpl },
    { ssh: applySsh, inventory: inventoryWithCustomSource }
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.script, dryRun.script);
  const installCall = applySsh.history.find((c) => c.command.includes('COMMUNITY_SCRIPTS_URL'));
  assert.ok(installCall, 'install script call should be recorded');
  assert.equal(installCall!.command, applied.script);
});

test('runInstallApp throws a resolution failure before any pct/install exec is recorded', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const failingFetch = (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      runInstallApp(
        { host: 'pve1', mid: 4, app: 'demo-shop', hostname: 'demo-shop', fetchImpl: failingFetch },
        { ssh, inventory: inventoryWithCustomSource }
      ),
    /Custom script repository example-user\/ProxmoxVED@my-apps: GitHub returned 403/
  );
  assert.equal(ssh.history.length, 0, 'no pct/install exec should have been recorded');
});

// T016 (US2): the R6 override warning must be the first thing a dry run
// prints -- runInstallApp logs it via logWarn before resolveMid/
// checkVmidAvailable/anything else, so it must be the very first captured
// console line when the resolved source shadows an upstream copy.
test('runInstallApp logs the R6 override warning as the first console line when the custom source shadows an upstream copy', async () => {
  const slug = 'demo-shop';
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === shadowUrl(UPSTREAM_STABLE_BASE, slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === shadowUrl(UPSTREAM_DEV_BASE, slug)) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await runInstallApp(
      { host: 'pve1', mid: 4, app: slug, hostname: slug, fetchImpl },
      { ssh: new FakeSSHClient(defaultResponder), inventory: inventoryWithCustomSource }
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(lines.length > 0, 'expected the override warning to be logged');
  assert.match(
    lines[0],
    /^\[WARN\s+\S+ \S+\] "demo-shop" is installing from the custom script repository example-user\/ProxmoxVED@my-apps \(commit [0-9a-f]{7}\), which overrides the upstream copy in ProxmoxVE\. Unset customScriptsRepo\/customScriptsBranch with set-config to use upstream\.$/
  );
});

// issue #15 US1: an app the branch doesn't change, and that upstream has,
// installs from upstream exactly as with the feature off, with no warning.
test('runInstallApp resolves an unchanged upstream app to upstream with the feature on, script identical to feature-off, no warning', async () => {
  const slug = 'plex';
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === shadowUrl(UPSTREAM_STABLE_BASE, slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === shadowUrl(UPSTREAM_DEV_BASE, slug)) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  let featureOn: Awaited<ReturnType<typeof runInstallApp>>;
  try {
    featureOn = await runInstallApp(
      { host: 'pve1', mid: 4, app: slug, hostname: slug, fetchImpl },
      { ssh: new FakeSSHClient(defaultResponder), inventory: inventoryWithCustomSource }
    );
  } finally {
    console.error = originalError;
  }
  const featureOff = await runInstallApp(
    { host: 'pve1', mid: 4, app: slug, hostname: slug },
    { ssh: new FakeSSHClient(defaultResponder), inventory }
  );
  assert.deepEqual(featureOn.source, { kind: 'upstream', slug, shadows: [] });
  assert.equal(featureOn.script, featureOff.script);
  assert.deepEqual(lines, [], 'no warning expected for an unchanged upstream app');
});

test('runInstallApp uses a passed-in opts.source without ever calling fetch', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const throwingFetch = (async () => {
    throw new Error('runInstallApp should not have called fetch when opts.source is already given');
  }) as unknown as typeof fetch;
  const source: AppSource = { kind: 'upstream', slug: 'plex', shadows: [] };
  const result = await runInstallApp(
    { host: 'pve1', mid: 4, app: 'plex', hostname: 'plex', source, fetchImpl: throwingFetch },
    { ssh, inventory: inventoryWithCustomSource }
  );
  assert.equal(result.applied, false);
  assert.equal(result.source, source);
});
