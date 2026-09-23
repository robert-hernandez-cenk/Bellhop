import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuthUser, requireAdminGroup, isAdminUser, authMode } from '../../src/web/auth.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';

const ADMIN_GROUP_NAME = authentikConfig({}).adminGroup;
const AUTHENTIK_BUILTIN_ADMIN_GROUP_NAME = authentikConfig({}).builtinAdminGroup;

test('resolveAuthUser returns a user from Authentik forward-auth headers, splitting groups on |', () => {
  const user = resolveAuthUser({
    'x-authentik-username': 'alice',
    'x-authentik-email': 'alice@example.com',
    'x-authentik-groups': 'admins|homelab',
  });
  assert.deepEqual(user, { username: 'alice', email: 'alice@example.com', groups: ['admins', 'homelab'] });
});

test('resolveAuthUser defaults email to undefined and groups to [] when those headers are absent', () => {
  const user = resolveAuthUser({ 'x-authentik-username': 'alice' });
  assert.deepEqual(user, { username: 'alice', email: undefined, groups: [] });
});

test('resolveAuthUser falls back to WEB_UI_DEV_USER when no trusted headers are present', () => {
  const original = process.env.WEB_UI_DEV_USER;
  process.env.WEB_UI_DEV_USER = 'local-dev';
  try {
    const user = resolveAuthUser({});
    assert.deepEqual(user, { username: 'local-dev', groups: [] });
  } finally {
    if (original === undefined) delete process.env.WEB_UI_DEV_USER;
    else process.env.WEB_UI_DEV_USER = original;
  }
});

test('resolveAuthUser returns undefined in strict authentik mode with no headers and no dev bypass', () => {
  assert.equal(resolveAuthUser({}, { WEB_UI_AUTH_MODE: 'authentik' }), undefined);
});

test('authMode defaults to auto when the variable is unset or empty', () => {
  assert.equal(authMode({}), 'auto');
  assert.equal(authMode({ WEB_UI_AUTH_MODE: '' }), 'auto');
});

test('authMode rejects an unrecognized value, listing the valid ones', () => {
  assert.throws(() => authMode({ WEB_UI_AUTH_MODE: 'oidc' }), /must be one of auto, authentik, none/);
});

test('auto mode with no headers yields the synthetic local operator, who is an admin', () => {
  const user = resolveAuthUser({}, {});
  assert.deepEqual(user, { username: 'local', groups: [ADMIN_GROUP_NAME], localOperator: true });
  assert.equal(isAdminUser(user!.groups, {}), true);
});

test('WEB_UI_LOCAL_USER names the local operator', () => {
  const user = resolveAuthUser({}, { WEB_UI_LOCAL_USER: 'alice' });
  assert.equal(user!.username, 'alice');
});

// The property that keeps the inferred default safe on a configured
// instance: if the flag goes unset on a deployment that really does have
// forward-auth, users keep their real groups instead of every one of them
// silently becoming an admin.
test('auto mode with headers yields the header identity, with real groups and no admin promotion', () => {
  const user = resolveAuthUser({ 'x-authentik-username': 'someone', 'x-authentik-groups': 'homelab' }, {});
  assert.equal(user!.localOperator, undefined);
  assert.equal(isAdminUser(user!.groups, {}), false);
  assert.deepEqual(user, { username: 'someone', email: undefined, groups: ['homelab'] });
});

test('none mode ignores trusted headers entirely and always yields the local operator', () => {
  const user = resolveAuthUser({ 'x-authentik-username': 'someone', 'x-authentik-groups': 'homelab' }, { WEB_UI_AUTH_MODE: 'none' });
  assert.deepEqual(user, { username: 'local', groups: [ADMIN_GROUP_NAME], localOperator: true });
});

test('auto mode resolution order is headers, then WEB_UI_DEV_USER, then the local operator', () => {
  const fromHeaders = resolveAuthUser({ 'x-authentik-username': 'header-user' }, { WEB_UI_DEV_USER: 'dev-user' });
  assert.equal(fromHeaders!.username, 'header-user');
  const fromDev = resolveAuthUser({}, { WEB_UI_DEV_USER: 'dev-user' });
  assert.equal(fromDev!.username, 'dev-user');
  assert.equal(fromDev!.localOperator, undefined);
  const fromLocal = resolveAuthUser({}, {});
  assert.equal(fromLocal!.username, 'local');
});

test('isAdminUser honors a configured admin group name', () => {
  assert.equal(isAdminUser(['my-admins'], { AUTHENTIK_ADMIN_GROUP: 'my-admins' }), true);
  assert.equal(isAdminUser([ADMIN_GROUP_NAME], { AUTHENTIK_ADMIN_GROUP: 'my-admins' }), false);
});

test('isAdminUser honors a configured built-in admin group name', () => {
  assert.equal(isAdminUser(['superusers'], { AUTHENTIK_BUILTIN_ADMIN_GROUP: 'superusers' }), true);
});

test('resolveAuthUser ignores an empty x-authentik-username header and falls back to the dev bypass', () => {
  const original = process.env.WEB_UI_DEV_USER;
  process.env.WEB_UI_DEV_USER = 'local-dev';
  try {
    const user = resolveAuthUser({ 'x-authentik-username': '' });
    assert.deepEqual(user, { username: 'local-dev', groups: [] });
  } finally {
    if (original === undefined) delete process.env.WEB_UI_DEV_USER;
    else process.env.WEB_UI_DEV_USER = original;
  }
});

test('resolveAuthUser honors WEB_UI_DEV_GROUPS as a pipe-delimited list alongside WEB_UI_DEV_USER', () => {
  const originalUser = process.env.WEB_UI_DEV_USER;
  const originalGroups = process.env.WEB_UI_DEV_GROUPS;
  process.env.WEB_UI_DEV_USER = 'local-dev';
  process.env.WEB_UI_DEV_GROUPS = 'bellhop-admins|homelab';
  try {
    const user = resolveAuthUser({});
    assert.deepEqual(user, { username: 'local-dev', groups: ['bellhop-admins', 'homelab'] });
  } finally {
    if (originalUser === undefined) delete process.env.WEB_UI_DEV_USER;
    else process.env.WEB_UI_DEV_USER = originalUser;
    if (originalGroups === undefined) delete process.env.WEB_UI_DEV_GROUPS;
    else process.env.WEB_UI_DEV_GROUPS = originalGroups;
  }
});

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
    },
  };
  return { res: res as unknown as Parameters<typeof requireAdminGroup>[1], state };
}

test('requireAdminGroup calls next() when the user is in the admin group', () => {
  const req = { user: { username: 'alice', groups: [ADMIN_GROUP_NAME] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('requireAdminGroup calls next() when the user is only in the built-in authentik Admins group', () => {
  const req = { user: { username: 'alice', groups: [AUTHENTIK_BUILTIN_ADMIN_GROUP_NAME] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('requireAdminGroup returns 403 when authenticated but not in the admin group', () => {
  const req = { user: { username: 'alice', groups: ['homelab'] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res, state } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: 'forbidden' });
});

test('requireAdminGroup returns 403 when req.user is undefined', () => {
  const req = {} as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res, state } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
});
