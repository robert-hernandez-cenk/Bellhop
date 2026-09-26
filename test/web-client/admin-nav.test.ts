import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminNavLinks } from '../../web-client/src/lib/admin-nav.ts';

test('adminNavLinks(false, false) returns []', () => {
  assert.deepEqual(adminNavLinks(false, false), []);
});

test('adminNavLinks(false, true) returns []', () => {
  assert.deepEqual(adminNavLinks(false, true), []);
});

test('adminNavLinks(true, false) returns only Settings', () => {
  assert.deepEqual(adminNavLinks(true, false), [{ to: '/settings', label: 'Settings' }]);
});

test('adminNavLinks(true, true) returns Users, Permissions, Settings in that order', () => {
  assert.deepEqual(adminNavLinks(true, true), [
    { to: '/users', label: 'Users' },
    { to: '/permissions', label: 'Permissions' },
    { to: '/settings', label: 'Settings' },
  ]);
});
