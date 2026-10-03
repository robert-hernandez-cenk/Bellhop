import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_CREATOR_ROLE,
  RealmInfoSchema,
  buildRealmReadCommand,
  buildGrantScript,
  creatorGrantPreview,
  pveUserIdFor,
} from '../../src/lib/pve-acl.ts';
import type { Inventory } from '../../src/lib/inventory.ts';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'proxmox');
const fixture = (name: string) => readFileSync(path.join(fixtureDir, name), 'utf8');

const baseInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

test('buildRealmReadCommand prints only the filtered type/username-claim fields, under pipefail, with the realm shell-quoted', () => {
  const cmd = buildRealmReadCommand('authentik');
  assert.equal(
    cmd,
    `set -o pipefail; pvesh get '/access/domains/authentik' --output-format json | perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print encode_json({ type => $d->{type}, "username-claim" => $d->{"username-claim"} }), "\\n"'`
  );
  assert.match(buildRealmReadCommand("it's"), /'\/access\/domains\/it'\\''s'/);
});

test('RealmInfoSchema parses the captured openid-email and pve realm responses', () => {
  assert.deepEqual(RealmInfoSchema.parse(JSON.parse(fixture('realm-openid-email.json'))), {
    type: 'openid',
    'username-claim': 'email',
  });
  assert.deepEqual(RealmInfoSchema.parse(JSON.parse(fixture('realm-pve.json'))), {
    type: 'pve',
    'username-claim': null,
  });
});

test('pveUserIdFor maps a username-claim realm to <username>@<realm>', () => {
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'username' }, { username: 'alice', email: 'alice@example.com' }),
    { userid: 'alice@authentik' }
  );
});

test('pveUserIdFor maps an email-claim realm to <email>@<realm>', () => {
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'email' }, { username: 'alice', email: 'alice@example.com' }),
    { userid: 'alice@example.com@authentik' }
  );
});

test('buildGrantScript is the two-line create-if-missing + acl modify script with every value shell-quoted', () => {
  assert.equal(
    buildGrantScript('alice@example.com@authentik', 4005, 'PVEVMAdmin'),
    [
      `pvesh get '/access/users/alice@example.com@authentik' >/dev/null 2>&1 || pveum user add 'alice@example.com@authentik' --comment 'Created by Bellhop for VM 4005'`,
      `pveum acl modify '/vms/4005' --users 'alice@example.com@authentik' --roles 'PVEVMAdmin'`,
    ].join('\n')
  );
});

test('creatorGrantPreview names the role, VMID, username and realm when the realm is set', () => {
  const inv = { ...baseInventory, pveUserRealm: 'authentik' };
  assert.equal(
    creatorGrantPreview(inv, { username: 'alice', email: 'alice@example.com' }, 4005),
    `Would grant ${DEFAULT_CREATOR_ROLE} on /vms/4005 to alice's Proxmox account (realm authentik)`
  );
  assert.equal(
    creatorGrantPreview({ ...inv, pveCreatorRole: 'PVEVMUser' }, { username: 'alice' }, 4005),
    `Would grant PVEVMUser on /vms/4005 to alice's Proxmox account (realm authentik)`
  );
});

test('creatorGrantPreview is undefined when pveUserRealm is unset', () => {
  assert.equal(creatorGrantPreview(baseInventory, { username: 'alice' }, 4005), undefined);
});
