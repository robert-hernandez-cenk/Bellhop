import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVISIONING_COMMANDS, MAINTENANCE_ACTIONS } from '../../src/web/commands-meta.ts';

test('every provisioning command has a unique id and at least one field', () => {
  const ids = PROVISIONING_COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 7);
  for (const cmd of PROVISIONING_COMMANDS) {
    assert.ok(cmd.fields.length > 0, `${cmd.id} should declare fields`);
  }
});

test('migrate-nfs-mount is not listed (every guest already migrated to host-relay bind-mounts)', () => {
  assert.ok(!PROVISIONING_COMMANDS.some((c) => c.id === 'migrate-nfs-mount'));
});

test('create-lxc declares host/mid/hostname/template/cores/memory/disk/bridge/storage/subdomains/nfsStorage/nfsMountPoint fields', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'create-lxc')!;
  const names = cmd.fields.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'bridge',
    'cores',
    'disk',
    'host',
    'hostname',
    'insecureBackendTls',
    'memory',
    'mid',
    'nfsMountPoint',
    'nfsStorage',
    'storage',
    'subdomains',
    'template',
  ]);
});

test('storage fields declare their storageContentTypes filter', () => {
  const createLxc = PROVISIONING_COMMANDS.find((c) => c.id === 'create-lxc')!;
  const storage = createLxc.fields.find((f) => f.name === 'storage')!;
  assert.equal(storage.kind, 'select-storage');
  assert.deepEqual(storage.storageContentTypes, ['rootdir', 'images']);

  const createVm = PROVISIONING_COMMANDS.find((c) => c.id === 'create-vm')!;
  const diskStorage = createVm.fields.find((f) => f.name === 'diskStorage')!;
  assert.equal(diskStorage.kind, 'select-storage');
  assert.deepEqual(diskStorage.storageContentTypes, ['images']);

  const installApp = PROVISIONING_COMMANDS.find((c) => c.id === 'install-app')!;
  const templateStorage = installApp.fields.find((f) => f.name === 'templateStorage')!;
  assert.equal(templateStorage.kind, 'select-storage');
  assert.deepEqual(templateStorage.storageContentTypes, ['vztmpl']);
  const containerStorage = installApp.fields.find((f) => f.name === 'containerStorage')!;
  assert.equal(containerStorage.kind, 'select-storage');
  assert.deepEqual(containerStorage.storageContentTypes, ['rootdir', 'images']);
});

test("migrate-guest's storage field is scoped to toHost via hostField, cross-checked against a real toHost field", () => {
  // I3: hostField: 'toHost' is a magic string with no test pinning it --
  // if either this value or the actual field named 'toHost' below is ever
  // renamed without updating the other, the storage dropdown silently
  // reverts to permanently showing "Select a host first...", with a fully
  // green test suite. Assert both facts, cross-checked against each other,
  // not just each against a hardcoded literal that could drift the same way.
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'migrate-guest')!;
  const storage = cmd.fields.find((f) => f.name === 'storage')!;
  assert.equal(storage.kind, 'select-storage');
  assert.deepEqual(storage.storageContentTypes, ['rootdir', 'images']);
  assert.ok(storage.hostField, 'migrate-guest storage field must declare a hostField');
  const hostField = cmd.fields.find((f) => f.name === storage.hostField);
  assert.ok(hostField, `migrate-guest must have a field literally named '${storage.hostField}'`);
  assert.equal(storage.hostField, 'toHost');
});

test("migrate-guest's mid field is scoped to toHost via hostField, cross-checked against a real toHost field", () => {
  // Same I3 concern as the storage field's own hostField test above --
  // pin both the hostField value and the existence of a field literally
  // named 'toHost', cross-checked against each other.
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'migrate-guest')!;
  const mid = cmd.fields.find((f) => f.name === 'mid')!;
  assert.equal(mid.kind, 'mid');
  assert.ok(mid.hostField, 'migrate-guest mid field must declare a hostField');
  const hostField = cmd.fields.find((f) => f.name === mid.hostField);
  assert.ok(hostField, `migrate-guest must have a field literally named '${mid.hostField}'`);
  assert.equal(mid.hostField, 'toHost');
});

test('deploy-vpn-gateway declares host/mid/name/vpn/credential/storage fields', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const names = cmd.fields.map((f) => f.name).sort();
  assert.deepEqual(names, ['accessToken', 'host', 'mid', 'name', 'piaPassword', 'piaUsername', 'storage', 'vpn']);
});

test("deploy-vpn-gateway's NordVPN access token field only shows when vpn is 'nordvpn', and is masked", () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const field = cmd.fields.find((f) => f.name === 'accessToken')!;
  assert.equal(field.kind, 'secret');
  assert.deepEqual(field.showIf, { field: 'vpn', value: 'nordvpn' });
});

test("deploy-vpn-gateway's PIA username/password fields only show when vpn is 'pia'; only the password is masked", () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const username = cmd.fields.find((f) => f.name === 'piaUsername')!;
  const password = cmd.fields.find((f) => f.name === 'piaPassword')!;
  assert.equal(username.kind, 'text');
  assert.deepEqual(username.showIf, { field: 'vpn', value: 'pia' });
  assert.equal(password.kind, 'secret');
  assert.deepEqual(password.showIf, { field: 'vpn', value: 'pia' });
});

test('deploy-vpn-gateway declares a required name field with the vpn-gateway-name kind', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const field = cmd.fields.find((f) => f.name === 'name')!;
  assert.equal(field.kind, 'vpn-gateway-name');
  assert.equal(field.required, true);
});

test('deploy-vpn-gateway lists VPN Provider first, ahead of Host/MID/Name', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const order = cmd.fields.map((f) => f.name);
  assert.deepEqual(order.slice(0, 4), ['vpn', 'host', 'mid', 'name']);
});

test("deploy-vpn-gateway's storage field declares its storageContentTypes filter", () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const storage = cmd.fields.find((f) => f.name === 'storage')!;
  assert.equal(storage.kind, 'select-storage');
  assert.deepEqual(storage.storageContentTypes, ['rootdir', 'images']);
});

test("deploy-vpn-gateway's vpn field offers exactly nordvpn/pia as options", () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'deploy-vpn-gateway')!;
  const vpnField = cmd.fields.find((f) => f.name === 'vpn')!;
  assert.equal(vpnField.kind, 'select-strict');
  assert.deepEqual(vpnField.options, ['nordvpn', 'pia']);
});

test('install-app declares a numeric port field', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'install-app')!;
  const portField = cmd.fields.find((f) => f.name === 'port')!;
  assert.ok(portField, 'install-app should declare a port field');
  assert.equal(portField.kind, 'number');
});

test('attach-nfs-mount declares an outage warning', () => {
  const attach = PROVISIONING_COMMANDS.find((c) => c.id === 'attach-nfs-mount')!;
  assert.ok(attach.warning);
});

test("attach-nfs-mount's storage field is a select-nfs-mount dropdown, not free text", () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'attach-nfs-mount')!;
  const storage = cmd.fields.find((f) => f.name === 'storage')!;
  assert.equal(storage.kind, 'select-nfs-mount');
});

test('every maintenance action has a unique id and a valid mode', () => {
  const ids = MAINTENANCE_ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 3);
  for (const action of MAINTENANCE_ACTIONS) {
    assert.ok(['read-only', 'run-only', 'preview-apply'].includes(action.mode));
  }
});

test('install-app declares its app field as a free-text app-check with a checkEndpoint', () => {
  const cmd = PROVISIONING_COMMANDS.find((c) => c.id === 'install-app')!;
  const appField = cmd.fields.find((f) => f.name === 'app')!;
  assert.equal(appField.kind, 'app-check');
  assert.equal(appField.checkEndpoint, '/provisioning/install-app/check-app');
  assert.equal(appField.options, undefined, 'app-check is free text, not a dropdown');
});

test('every provisioning command and maintenance action has a non-empty description', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    assert.ok(cmd.description && cmd.description.length > 0, `${cmd.id} should have a description`);
  }
  for (const action of MAINTENANCE_ACTIONS) {
    assert.ok(action.description && action.description.length > 0, `${action.id} should have a description`);
  }
});

test('provisioning commands are ordered alphabetically by label', () => {
  const labels = PROVISIONING_COMMANDS.map((c) => c.label);
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(labels, sorted);
});

test('maintenance actions are ordered alphabetically by label', () => {
  const labels = MAINTENANCE_ACTIONS.map((a) => a.label);
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(labels, sorted);
});
