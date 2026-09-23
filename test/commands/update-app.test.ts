import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runUpdateApp, buildUpdateAppScript } from '../../src/commands/maintenance/update-app.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'plex', type: 'lxc', vmid: 105, host: 'pve1' }],
};

test('buildUpdateAppScript embeds the community-scripts URL for the app', () => {
  const script = buildUpdateAppScript('plex');
  assert.match(script, /raw\.githubusercontent\.com\/community-scripts\/ProxmoxVE\/main\/ct\/plex\.sh/);
});

test('buildUpdateAppScript exports TERM before anything else, so build.func\'s clear call does not abort the update', () => {
  const script = buildUpdateAppScript('plex');
  assert.equal(script.split('\n')[0], 'export TERM=xterm');
});

test('buildUpdateAppScript exports PHS_SILENT=1 so build.func runs update_script instead of showing its menu', () => {
  const script = buildUpdateAppScript('plex');
  assert.match(script, /^export PHS_SILENT=1$/m);
});

test('runUpdateApp rejects an invalid app name', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runUpdateApp({ guest: 'plex', app: 'Plex Media' }, { ssh, inventory }),
    /--app must contain only lowercase letters/
  );
});

test('runUpdateApp rejects an unknown guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runUpdateApp({ guest: 'nope', app: 'plex' }, { ssh, inventory }),
    /Unknown inventory entry: nope/
  );
});

test('runUpdateApp does not call ssh when apply is not set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex' }, { ssh, inventory });
  assert.equal(result.ran, false);
  assert.equal(ssh.history.length, 0);
});

test('runUpdateApp runs the script on the guest when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex', apply: true }, { ssh, inventory });
  assert.equal(result.ran, true);
  assert.equal(ssh.history.length, 1);
  assert.match(ssh.history[0].command, /pct exec 105/);
});

test('runUpdateApp surfaces a non-zero exit code from the remote script', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'CTID not set', code: 1 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex', apply: true }, { ssh, inventory });
  assert.equal(result.ran, true);
  assert.equal(result.result?.code, 1);
  assert.equal(result.result?.stderr, 'CTID not set');
});
