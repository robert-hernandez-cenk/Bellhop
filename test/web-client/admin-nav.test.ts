import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminNavLinks, NO_AUTH_BANNER_TEXT } from '../../web-client/src/lib/admin-nav.ts';

test('adminNavLinks(false, false) returns []', () => {
  assert.deepEqual(adminNavLinks(false, false), []);
});

test('adminNavLinks(false, true) returns []', () => {
  assert.deepEqual(adminNavLinks(false, true), []);
});

test('adminNavLinks(true, false) returns Tasks and Settings', () => {
  assert.deepEqual(adminNavLinks(true, false), [
    { to: '/tasks', label: 'Tasks' },
    { to: '/settings', label: 'Settings' },
  ]);
});

test('adminNavLinks(true, true) returns Users, Permissions, Tasks, Settings in that order', () => {
  assert.deepEqual(adminNavLinks(true, true), [
    { to: '/users', label: 'Users' },
    { to: '/permissions', label: 'Permissions' },
    { to: '/tasks', label: 'Tasks' },
    { to: '/settings', label: 'Settings' },
  ]);
});

test('NO_AUTH_BANNER_TEXT points at the Settings page sign-in setting, with the env var as the alternative', () => {
  assert.match(NO_AUTH_BANNER_TEXT, /Web UI sign-in \(webUiAuthMode\) to authentik on the Settings page/);
  assert.match(NO_AUTH_BANNER_TEXT, /or WEB_UI_AUTH_MODE=authentik in the service environment/);
  assert.ok(!NO_AUTH_BANNER_TEXT.startsWith('Set WEB_UI_AUTH_MODE'), 'the setting comes first, not the variable');
});
