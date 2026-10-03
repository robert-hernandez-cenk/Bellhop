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
  grantCreatorAccess,
} from '../../src/lib/pve-acl.ts';
import type { Inventory } from '../../src/lib/inventory.ts';
import type { SSHClient } from '../../src/lib/ssh-client.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { withCapturedConsole } from '../../src/web/console-capture.ts';

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

// --- pveUserIdFor's skip branches (T011) ---

test('pveUserIdFor skips a non-OpenID realm, using the type from the captured pve-realm fixture', () => {
  const info = RealmInfoSchema.parse(JSON.parse(fixture('realm-pve.json')));
  assert.deepEqual(pveUserIdFor('authentik', info, { username: 'alice' }), {
    skip: "Skipping Proxmox creator grant: realm 'authentik' is type 'pve', not openid -- set pveUserRealm to an OpenID realm",
  });
});

test('pveUserIdFor skips an explicit subject claim', () => {
  assert.deepEqual(pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'subject' }, { username: 'alice' }), {
    skip:
      "Skipping Proxmox creator grant: realm 'authentik' names users by 'subject' -- set its username claim to 'username' or 'email' in Proxmox (Datacenter > Permissions > Realms)",
  });
});

test('pveUserIdFor skips a null or missing username-claim, naming it "subject (default)"', () => {
  const expected = {
    skip:
      "Skipping Proxmox creator grant: realm 'authentik' names users by 'subject (default)' -- set its username claim to 'username' or 'email' in Proxmox (Datacenter > Permissions > Realms)",
  };
  assert.deepEqual(pveUserIdFor('authentik', { type: 'openid', 'username-claim': null }, { username: 'alice' }), expected);
  assert.deepEqual(pveUserIdFor('authentik', { type: 'openid' }, { username: 'alice' }), expected);
});

test('pveUserIdFor skips an email-claim realm when the actor has no known email', () => {
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'email' }, { username: 'alice' }),
    { skip: "Skipping Proxmox creator grant: realm 'authentik' names users by email, but no email is known for 'alice'" }
  );
});

test('pveUserIdFor skips a username or email containing whitespace, \':\' or \'/\'', () => {
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'username' }, { username: 'ali ce' }),
    { skip: "Skipping Proxmox creator grant: 'ali ce' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')" }
  );
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'email' }, { username: 'alice', email: 'alice:bob@example.com' }),
    { skip: "Skipping Proxmox creator grant: 'alice:bob@example.com' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')" }
  );
  assert.deepEqual(
    pveUserIdFor('authentik', { type: 'openid', 'username-claim': 'email' }, { username: 'alice', email: 'alice/bob@example.com' }),
    { skip: "Skipping Proxmox creator grant: 'alice/bob@example.com' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')" }
  );
});

// --- grantCreatorAccess (T011) ---

const grantInventory: Inventory = { ...baseInventory, pveUserRealm: 'authentik' };
const alice = { username: 'alice', email: 'alice@example.com' };

const realmOpenidEmail = fixture('realm-openid-email.json');
const realmMissingStderr = fixture('realm-missing.stderr.txt').trim();
const userMissingStderr = fixture('user-missing.stderr.txt').trim();

const ALICE_GRANT_SCRIPT = buildGrantScript('alice@example.com@authentik', 4005, DEFAULT_CREATOR_ROLE);

test('grantCreatorAccess returns "off" and logs the off line once when pveUserRealm is unset', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, baseInventory, 'pve1', 4005, alice));
  assert.equal(result, 'off');
  assert.match(text, /Proxmox creator grant is off -- set pveUserRealm/);
  assert.equal(ssh.history.length, 0);
});

test('grantCreatorAccess returns "no-actor" and logs the no-actor line once when there is no signed-in user', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, undefined));
  assert.equal(result, 'no-actor');
  assert.match(text, /No Proxmox creator grant for VM 4005: no signed-in user \(only web UI jobs carry one\)/);
  assert.equal(ssh.history.length, 0);
});

test('grantCreatorAccess returns "skipped" when the realm read exits non-zero, naming the realm and Proxmox\'s stderr', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: realmMissingStderr, code: 255 }));
  const inv = { ...grantInventory, pveUserRealm: 'nosuchrealm' };
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, inv, 'pve1', 4005, alice));
  assert.equal(result, 'skipped');
  assert.ok(
    text.includes(
      `Skipping Proxmox creator grant: couldn't read realm 'nosuchrealm' (exit 255): ${realmMissingStderr} -- check that pveUserRealm names an existing OpenID realm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page)`
    ),
    text
  );
});

test('grantCreatorAccess returns "skipped" when the realm read exits 0 but the output does not parse', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: 'not json', stderr: '', code: 0 }));
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'skipped');
  assert.match(
    text,
    /Skipping Proxmox creator grant: couldn't read realm 'authentik' \(exit 0\): unexpected output -- check that pveUserRealm names an existing OpenID realm \(bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page\)/
  );
});

test('grantCreatorAccess returns "skipped" with the pveUserIdFor skip text, when the realm maps to no safe user ID', async () => {
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/access/domains/')) return { stdout: JSON.stringify({ type: 'pve' }), stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'skipped');
  assert.match(text, /realm 'authentik' is type 'pve', not openid/);
});

test('grantCreatorAccess returns "failed" when the grant script exits non-zero, warning with stderr and the full script', async () => {
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/access/domains/')) return { stdout: realmOpenidEmail, stderr: '', code: 0 };
    if (command.includes('pveum')) return { stdout: '', stderr: userMissingStderr, code: 2 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'failed');
  assert.ok(
    text.includes(
      `Failed to grant ${DEFAULT_CREATOR_ROLE} on VM 4005 to alice@example.com@authentik (exit 2): ${userMissingStderr} -- run on pve1 by hand:\n${ALICE_GRANT_SCRIPT}`
    ),
    text
  );
});

test('grantCreatorAccess returns "granted" and logs the grant once on success', async () => {
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/access/domains/')) return { stdout: realmOpenidEmail, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'granted');
  assert.match(text, /Granted PVEVMAdmin on VM 4005 to alice@example\.com@authentik/);
  assert.equal(ssh.history.length, 2);
});

// A rejected ssh.exec must never propagate out of grantCreatorAccess -- it
// is always run in a `finally` (research R7), so a thrown error here has to
// become a reported outcome instead.
function throwingSsh(shouldThrow: (command: string) => boolean, realmStdout = realmOpenidEmail): SSHClient {
  return {
    async exec(_target, command) {
      if (shouldThrow(command)) throw new Error('connection refused');
      if (command.includes('/access/domains/')) return { stdout: realmStdout, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async execInteractive() {
      throw new Error('not used in this test');
    },
    async putFile() {},
  };
}

test('grantCreatorAccess returns "skipped" (never throws) when the realm read itself rejects', async () => {
  const ssh = throwingSsh((command) => command.includes('/access/domains/'));
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'skipped');
  assert.ok(
    text.includes(
      "Skipping Proxmox creator grant: couldn't read realm 'authentik': connection refused -- check that pveUserRealm names an existing OpenID realm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page)"
    ),
    text
  );
});

test('grantCreatorAccess returns "failed" (never throws) when the grant script itself rejects, with no invented exit code', async () => {
  const ssh = throwingSsh((command) => command.includes('pveum'));
  const { text, result } = await withCapturedConsole(() => grantCreatorAccess(ssh, grantInventory, 'pve1', 4005, alice));
  assert.equal(result, 'failed');
  assert.ok(
    text.includes(
      `Failed to grant ${DEFAULT_CREATOR_ROLE} on VM 4005 to alice@example.com@authentik: connection refused -- run on pve1 by hand:\n${ALICE_GRANT_SCRIPT}`
    ),
    text
  );
});
