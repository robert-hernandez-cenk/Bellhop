import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { runSetConfig } from '../../src/commands/maintenance/set-config.ts';

const FIXTURE: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

function tempInventoryPath(inv: Inventory = FIXTURE): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

test('runSetConfig writes a value with --apply', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53', apply: true }, { inventoryPath });
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).dnsServer, '10.0.0.53');
});

test('runSetConfig writes nothing on a dry run', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53' }, { inventoryPath });
  assert.equal(result.applied, false);
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig --unset clears an existing value', () => {
  const inventoryPath = tempInventoryPath({ ...FIXTURE, dnsServer: '10.0.0.53' });
  runSetConfig({ key: 'dnsServer', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig rejects an unknown key', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'domain', value: 'other.com', apply: true }, { inventoryPath }),
    /Unknown setting 'domain'/
  );
});

test('runSetConfig rejects a value the schema refuses', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'statusPagePath', value: 'relative/path.html', apply: true }, { inventoryPath }),
    /must be an absolute path/
  );
});

test('runSetConfig requires a value when not unsetting', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'dnsServer', apply: true }, { inventoryPath }),
    /requires a value/
  );
});

test('runSetConfig round-trips customScriptsRepo through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  runSetConfig({ key: 'customScriptsRepo', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, undefined);
});

test('runSetConfig round-trips customScriptsBranch through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsBranch', value: 'my-apps', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, 'my-apps');
  runSetConfig({ key: 'customScriptsBranch', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});

test('runSetConfig rejects a customScriptsRepo not shaped like owner/repo', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsRepo', value: 'not-a-repo', apply: true }, { inventoryPath }),
    /must be owner\/repo/
  );
});

test('runSetConfig rejects a customScriptsBranch that looks like a path traversal', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsBranch', value: '../x', apply: true }, { inventoryPath }),
    /must be a valid git branch name/
  );
});

test('runSetConfig allows setting only customScriptsRepo without customScriptsBranch', () => {
  // The both-or-neither rule is enforced at the point of use
  // (customScriptSource), not by SettingsSchema -- set-config writes one
  // key at a time, so this must succeed on its own.
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig(
    { key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true },
    { inventoryPath }
  );
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});

test('runSetConfig round-trips proxyDriver through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyDriver', value: 'caddy', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'caddy');
  runSetConfig({ key: 'proxyDriver', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('runSetConfig rejects an unknown proxyDriver', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(() => runSetConfig({ key: 'proxyDriver', value: 'unknown-provider', apply: true }, { inventoryPath }), /proxyDriver/);
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('runSetConfig round-trips proxyConfigPath through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyConfigPath', value: '/etc/caddy/Caddyfile', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, '/etc/caddy/Caddyfile');
  runSetConfig({ key: 'proxyConfigPath', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, undefined);
});

test('runSetConfig rejects a relative proxyConfigPath', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyConfigPath', value: 'etc/caddy/Caddyfile', apply: true }, { inventoryPath }),
    /must be an absolute path/
  );
});

test('runSetConfig round-trips proxyTlsCertificate through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig(
    { key: 'proxyTlsCertificate', value: '/etc/ssl/example/fullchain.pem', apply: true },
    { inventoryPath }
  );
  assert.equal(loadInventory(inventoryPath).proxyTlsCertificate, '/etc/ssl/example/fullchain.pem');
  runSetConfig({ key: 'proxyTlsCertificate', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsCertificate, undefined);
});

test('runSetConfig rejects a relative proxyTlsCertificate', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () =>
      runSetConfig(
        { key: 'proxyTlsCertificate', value: 'etc/ssl/example/fullchain.pem', apply: true },
        { inventoryPath }
      ),
    /proxyTlsCertificate: must be an absolute path/
  );
});

test('runSetConfig round-trips proxyTlsKey through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyTlsKey', value: '/etc/ssl/example/privkey.pem', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsKey, '/etc/ssl/example/privkey.pem');
  runSetConfig({ key: 'proxyTlsKey', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsKey, undefined);
});

test('runSetConfig rejects a relative proxyTlsKey', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () =>
      runSetConfig({ key: 'proxyTlsKey', value: 'etc/ssl/example/privkey.pem', apply: true }, { inventoryPath }),
    /proxyTlsKey: must be an absolute path/
  );
});

test('runSetConfig round-trips proxyCertResolver through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyCertResolver', value: 'cloudflare', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCertResolver, 'cloudflare');
  runSetConfig({ key: 'proxyCertResolver', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCertResolver, undefined);
});

test('runSetConfig rejects a proxyCertResolver with characters other than letters, digits, - and _', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyCertResolver', value: 'my resolver', apply: true }, { inventoryPath }),
    /proxyCertResolver: must contain only letters, digits, - and _/
  );
});

test('runSetConfig round-trips proxyApiUrl through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyApiUrl', value: 'http://192.0.2.5:8080', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyApiUrl, 'http://192.0.2.5:8080');
  runSetConfig({ key: 'proxyApiUrl', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyApiUrl, undefined);
});

test('runSetConfig rejects a proxyApiUrl with a scheme other than http/https', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyApiUrl', value: 'ftp://192.0.2.5', apply: true }, { inventoryPath }),
    /proxyApiUrl: must be an http:\/\/ or https:\/\/ URL/
  );
});

test('runSetConfig round-trips proxyDriver nginx through --apply', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyDriver', value: 'nginx', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'nginx');
});

// issue #53, US3 (T014): pveUserRealm/pveCreatorRole, the Proxmox
// creator-grant settings -- set-config validates both against the same
// SettingsSchema regexes PATCH /api/settings uses (see
// test/web/routes/settings.test.ts), so the two front ends reject the
// same bad value with the same message.
test('runSetConfig round-trips pveUserRealm through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'pveUserRealm', value: 'authentik', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveUserRealm, 'authentik');
  runSetConfig({ key: 'pveUserRealm', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveUserRealm, undefined);
});

test('runSetConfig rejects a pveUserRealm that does not start with a letter', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveUserRealm', value: '1realm', apply: true }, { inventoryPath }),
    /pveUserRealm: must start with a letter and contain only letters, digits, \., - and _/
  );
  assert.equal(loadInventory(inventoryPath).pveUserRealm, undefined);
});

test('runSetConfig rejects a pveUserRealm with an invalid character', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveUserRealm', value: 'my realm', apply: true }, { inventoryPath }),
    /pveUserRealm: must start with a letter and contain only letters, digits, \., - and _/
  );
});

test('runSetConfig round-trips pveCreatorRole through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'pveCreatorRole', value: 'PVEVMAdmin', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, 'PVEVMAdmin');
  runSetConfig({ key: 'pveCreatorRole', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, undefined);
});

test('runSetConfig rejects a pveCreatorRole with an invalid character', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveCreatorRole', value: 'My Role', apply: true }, { inventoryPath }),
    /pveCreatorRole: must contain only letters, digits, \., - and _/
  );
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, undefined);
});
